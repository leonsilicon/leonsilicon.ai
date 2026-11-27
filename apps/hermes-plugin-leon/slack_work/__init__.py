"""Publish Slack activity from the gateway and the durable Orca relay."""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import re
import time
from contextlib import suppress

LOG = logging.getLogger(__name__)
URL = "https://autolinear.leonsilicon.ai/work"
CHANNEL = re.compile(r"[CGD][A-Z0-9]{1,30}")
THREAD = re.compile(r"[0-9]{10}\.[0-9]{6}")
# The Slack API removes the visual after two minutes. Refresh the display only.
DISPLAY_REFRESH = 60
# Keep an issue open when a handoff's runner cannot tell us when it stops.
UNOBSERVED_TOOLS = ("grok_bot_send", "muse_handoff", "muse_reply")


def unobserved_handoff(tool_name, args):
    def named(name):
        return tool_name == name or tool_name.endswith("_" + name)

    return any(map(named, UNOBSERVED_TOOLS)) or (
        named("send_message") and bool(args.get("slack_channel") and args.get("slack_thread_ts"))
    )


class Work:
    def __init__(self, adapter):
        self.adapter = adapter
        self.loop = asyncio.get_running_loop()
        self.changed = asyncio.Event()
        self.turns = {}
        self.finished = set()
        self.unobserved = set()
        self.display = {}
        self.sent = None
        self.version = 0
        self.retry_at = 0

    def route(self, event):
        source = event.source
        channel, message = source.chat_id, event.message_id
        if not CHANNEL.fullmatch(channel or "") or not THREAD.fullmatch(message or ""):
            return None
        thread = source.thread_id if THREAD.fullmatch(source.thread_id or "") else ""
        return source.scope_id or "", channel, message, thread

    def start(self, event):
        route = self.route(event)
        if route:
            team, channel, message, thread = route
            self.turns[team, channel, message] = thread
            self.changed.set()

    def end(self, event):
        route = self.route(event)
        if route:
            team, channel, message, _ = route
            if (team, channel, message) in self.turns:
                del self.turns[team, channel, message]
                if channel.startswith(("C", "G")):
                    self.finished.add(channel)
                self.changed.set()

    def observe_handoff(self, channel):
        if channel.startswith(("C", "G")) and any(current == channel for _, current, _ in self.turns):
            self.unobserved.add(channel)
            self.changed.set()

    def active(self):
        routes = {(team, channel, thread) for (team, channel, _), thread in self.turns.items()}
        orca = getattr(self.adapter, "_slack22orca_relay", None)
        if orca:
            routes.update(orca.store.active_routes())
        return routes

    async def report(self, channels):
        token = os.environ.get("AUTOLINEAR_TOKEN", "").strip()
        if not token or self.loop.time() < self.retry_at:
            return
        finished, unobserved = self.finished, self.unobserved
        if channels == self.sent and not finished and not unobserved:
            return
        self.finished, self.unobserved = set(), set()
        self.version = max(self.version + 1, time.time_ns() // 1000)
        url = os.environ.get("AUTOLINEAR_WORK_URL", "").strip() or URL
        import httpx

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                response = await client.post(url, headers={"Authorization": f"Bearer {token}"}, json={
                    "at": self.version, "active": sorted(channels), "finished": sorted(finished),
                    "unobserved": sorted(unobserved),
                })
                response.raise_for_status()
        except Exception as error:
            self.retry_at = self.loop.time() + 15
            self.finished.update(finished)
            self.unobserved.update(unobserved)
            LOG.warning("slack-work: could not report active runs (%s)", type(error).__name__)
        else:
            self.sent = channels

    async def render(self, routes):
        now = self.loop.time()
        desired = {(team, channel, thread) for team, channel, thread in routes if thread}

        async def set_status(route, working):
            team, channel, thread = route
            try:
                if self.adapter._outbound_blocked(channel, "set Slack thread status in"):
                    return
                client = self.adapter._get_client(channel, team_id=team or None)
                async with asyncio.timeout(5):
                    await client.api_call("assistant.threads.setStatus", json={
                        "channel_id": channel, "thread_ts": thread,
                        "status": "is working on it…" if working else "",
                    })
            except Exception as error:
                LOG.debug("slack-work: could not update thread status (%s)", type(error).__name__)

        updates = []
        for route in self.display.keys() - desired:
            del self.display[route]
            updates.append(set_status(route, False))
        for route in desired:
            if now >= self.display.get(route, 0):
                self.display[route] = now + DISPLAY_REFRESH
                updates.append(set_status(route, True))
        await asyncio.gather(*updates)

    async def run(self):
        while True:
            self.changed.clear()
            try:
                if self.adapter._running:
                    active = self.active()
                    channels = {channel for _, channel, _ in active if channel.startswith(("C", "G"))}
                    await asyncio.gather(self.render(active), self.report(channels))
            except Exception:
                LOG.exception("slack-work: could not read active runs")
            # Check durable Orca state and retry failed deliveries. Waiting here never expires a run.
            with suppress(TimeoutError):
                await asyncio.wait_for(self.changed.wait(), 2)


def register(ctx):
    work = None

    def wire(_native, adapter):
        nonlocal work
        if existing := getattr(adapter, "_slack_work", None):
            work = existing
            return
        start, complete, disconnect = (getattr(adapter, name, None) for name in
                                       ("on_processing_start", "on_processing_complete", "disconnect"))
        if not all(callable(method) for method in (start, complete, disconnect)):
            LOG.warning("slack-work: Slack adapter has no processing lifecycle")
            return
        work = adapter._slack_work = Work(adapter)
        current = work
        worker = asyncio.create_task(current.run())

        @functools.wraps(start)
        async def started(event):
            current.start(event)
            return await start(event)

        @functools.wraps(complete)
        async def completed(event, *args, **kwargs):
            try:
                return await complete(event, *args, **kwargs)
            finally:
                current.end(event)

        @functools.wraps(disconnect)
        async def disconnected(*args, **kwargs):
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker
            adapter._slack_work = None
            adapter.on_processing_start = start
            adapter.on_processing_complete = complete
            adapter.disconnect = disconnect
            return await disconnect(*args, **kwargs)

        adapter.on_processing_start = started
        adapter.on_processing_complete = completed
        adapter.disconnect = disconnected

    def before_tool(tool_name="", args=None, **_):
        if work is None or not tool_name or not unobserved_handoff(tool_name, args or {}):
            return
        from gateway.session_context import get_session_env

        if get_session_env("HERMES_SESSION_PLATFORM") == "slack" and not work.loop.is_closed():
            work.loop.call_soon_threadsafe(work.observe_handoff, get_session_env("HERMES_SESSION_CHAT_ID") or "")

    ctx.register_platform_handler("slack", wire)
    ctx.register_hook("pre_tool_call", before_tool)
