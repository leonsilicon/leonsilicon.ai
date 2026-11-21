"""Give each of Leon's Slack messages its own Linear issue and channel the moment it arrives.

Leon's rule (2026-11-21): every message he sends Hermes in Slack outside an issue channel becomes a
new Linear issue in Awaiting Init (the team's default status) with its own channel, at once; his
message is edited to link the channel, and Hermes answers, and keeps the conversation going, there.

autolinear (autolinear.leonsilicon.ai) does the work: it creates the issue and the channel, edits
Leon's message, and posts the message again in the channel as Leon, marked like slack-as-leon's
posts, then answers with the channel and the copy's ts. This plugin calls it at two seams of the
live Slack adapter:

- ``_prefilter_inbound``: the moment one of Leon's messages has passed dedup and the bot check, it
  starts the request in the background, before Hermes reads the thread or downloads files. Only
  messages Hermes is sure to answer start this early: Leon's, outside an issue channel, not a
  command, mentioning no one but Hermes.
- ``_build_message_event``: runs only after every gate (auth, channel, mention, bot) has accepted a
  message, so it sees exactly the messages Hermes answers. It waits for the request started early,
  or starts it then, and builds the turn as if Leon had written the copy: same text, files and
  thread history, in the new channel. Hermes's session, reply and 👀 → ✅ land there. Both new and
  existing issue channels get the same handoff rule: post the reply that mentions Leon and let
  slack22linear move the issue to Awaiting Leon from that message.

The copy's own event carries slack-as-leon's marker, so ``slack-as-leon-guard`` drops it and Hermes
doesn't answer the message twice. That plugin must be enabled too.

It fails open: when autolinear can't be reached, errors or declines, Hermes answers where the
message is, as before. When the adapter internals it relies on disappear, it logs a warning and
does nothing.
"""

from __future__ import annotations

import asyncio
import functools
import json
import logging
import os
import re
import urllib.error
import urllib.request
from typing import Any, Optional

logger = logging.getLogger(__name__)

_PATCHED_ATTR = "_autolinear_patched"
_PENDING_ATTR = "_autolinear_pending"
_warned_guard = False

#: Settings, from Hermes's environment ($HERMES_HOME/.env). Without the first two, the plugin is off.
TOKEN_ENV = "AUTOLINEAR_TOKEN"
USER_ENV = "AUTOLINEAR_USER_ID"  # Leon's Slack user ID
URL_ENV = "AUTOLINEAR_URL"
PREFIX_ENV = "AUTOLINEAR_CHANNEL_PREFIX"
SKIP_ENV = "AUTOLINEAR_SKIP_CHANNELS"

DEFAULT_URL = "https://autolinear.leonsilicon.ai/intake"
DEFAULT_PREFIX = "leon"
#: First group of the client_msg_id on posts made as Leon by slack-as-leon and autolinear.
MARKER = "de1e6a7e"
TIMEOUT_SECONDS = 20.0
RETRY_DELAY_SECONDS = 1.0
#: How long building a turn waits for its intake before answering in place.
WAIT_SECONDS = 25.0
#: How long an intake nobody waited for is kept, in case its turn is still being built.
KEEP_SECONDS = 120.0

# Thread bookkeeping that belongs to where the message was, not to its copy at the top of a channel.
_THREAD_KEYS = (
    "thread_ts", "parent_user_id", "reply_count", "reply_users", "reply_users_count",
    "latest_reply", "replies", "subscribed", "last_read", "edited", "_slack_changed_event_ts",
)
_MENTION = re.compile(r"<@([UW][A-Z0-9]+)")
_HANDOFF_PROMPT = (
    "Slack22Linear owns the handoff to Awaiting Leon in this issue channel. "
    "When Leon needs or would want to see something, post the complete reply here with "
    "a real Slack @mention of Leon. Keep that mention in the Slack reply so Slack22Linear "
    "moves the issue after the reply is posted. Omit the status field from Linear updates "
    "that save notes, drafts, or approval details for this handoff. Slack22Linear also "
    "handles completion for replies that don't need a mention."
)


def _settings() -> Optional[dict[str, Any]]:
    """Read on every message, so a change to Hermes's env applies without rewiring."""
    token = os.environ.get(TOKEN_ENV, "").strip()
    user = os.environ.get(USER_ENV, "").strip()
    if not token or not user:
        return None
    prefix = os.environ.get(PREFIX_ENV, "").strip() or DEFAULT_PREFIX
    return {
        "token": token,
        "user": user,
        "url": os.environ.get(URL_ENV, "").strip() or DEFAULT_URL,
        "issue_channel": re.compile(rf"^{re.escape(prefix)}-\d+(?:-|$)"),
        "skip": {c.strip() for c in os.environ.get(SKIP_ENV, "").split(",") if c.strip()},
    }


def _post_json(url: str, token: str, payload: dict, timeout: float) -> tuple[int, dict]:
    """One POST. Returns the status and JSON body; raises on a network failure."""
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode(), method="POST",
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            # Cloudflare refuses some default user agents on this zone.
            "user-agent": "hermes-autolinear/1.0",
        })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        body = error.read() or b""
        try:
            return error.code, json.loads(body)
        except ValueError:
            return error.code, {"error": body[:200].decode(errors="replace")}


async def _request_intake(settings: dict, payload: dict) -> Optional[dict]:
    """Asks autolinear for the issue. Retries once on a network error or a 5xx: an intake runs
    once per message, so a retry gets the same issue. None when it declines; raises on failure."""
    for attempt in (1, 2):
        try:
            status, body = await asyncio.to_thread(
                _post_json, settings["url"], settings["token"], payload, TIMEOUT_SECONDS)
        except (urllib.error.URLError, TimeoutError, OSError):
            if attempt == 2:
                raise
            await asyncio.sleep(RETRY_DELAY_SECONDS)
            continue
        if status >= 500 and attempt == 1:
            await asyncio.sleep(RETRY_DELAY_SECONDS)
            continue
        if status != 200:
            raise RuntimeError(f"autolinear answered {status}: {body.get('error')}")
        if body.get("ok"):
            return body
        logger.info(
            "autolinear: left %s:%s alone (%s); answering it there",
            payload["channel"], payload["ts"], body.get("skipped"))
        return None
    return None


def _pending(adapter) -> dict:
    pending = getattr(adapter, _PENDING_ATTR, None)
    if pending is None:
        pending = {}
        setattr(adapter, _PENDING_ATTR, pending)
    return pending


def _is_marked(event: dict) -> bool:
    value = event.get("client_msg_id")
    return isinstance(value, str) and value.startswith(f"{MARKER}-")


def _where(event: dict, channel_id: str, name: str) -> str:
    kind = event.get("channel_type") or ("im" if channel_id.startswith("D") else "")
    place = ("a DM with Hermes" if kind == "im" else "a group DM" if kind == "mpim"
             else f"#{name}" if name and name != channel_id else "a channel")
    thread = event.get("thread_ts")
    return f"a thread in {place}" if thread and thread != event.get("ts") else place


async def _start(adapter, settings: dict, event: dict, channel_id: str, team_id: str):
    """Starts the intake for a message in the background, unless it's in an issue channel."""
    pending = _pending(adapter)
    ts = str(event.get("ts") or "")
    key = (channel_id, ts)
    if key in pending:
        return pending[key]
    if channel_id in settings["skip"]:
        return None
    name = str(await adapter._resolve_channel_name(channel_id, team_id=team_id) or "")
    if settings["issue_channel"].match(name):
        return None
    global _warned_guard
    if not getattr(adapter, "_slack_as_leon_guard_patched", False) and not _warned_guard:
        _warned_guard = True
        logger.warning(
            "autolinear: slack-as-leon-guard isn't wired, so Hermes may answer the copy of Leon's "
            "message a second time; enable that plugin")
    thread = event.get("thread_ts")
    payload = {
        "channel": channel_id, "ts": ts,
        "thread_ts": thread if thread and thread != ts else None,
        "user": str(event.get("user") or ""),
        "text": str(event.get("text") or ""),
        "where": _where(event, channel_id, name),
    }
    if isinstance(event.get("blocks"), list):
        payload["blocks"] = event["blocks"]
    files = [f for f in event.get("files") or [] if isinstance(f, dict)]
    if files:
        payload["files"] = [
            {"name": f.get("name") or "", "title": f.get("title") or "",
             "permalink": f.get("permalink") or ""} for f in files]
    task = asyncio.ensure_future(_request_intake(settings, payload))
    pending[key] = task

    def forget(_task) -> None:
        # Kept a while for a turn still being built, then dropped; one nobody took is logged.
        def drop() -> None:
            if pending.pop(key, None) is not None and not _task.cancelled():
                result = _task.exception() is None and _task.result()
                if result:
                    logger.warning(
                        "autolinear: made %s for %s:%s, but Hermes didn't answer that message",
                        result["issue"]["identifier"], channel_id, ts)
        asyncio.get_running_loop().call_later(KEEP_SECONDS, drop)

    task.add_done_callback(forget)
    return task


def _answers_for_sure(adapter, settings: dict, event: dict, team_id: str) -> bool:
    """True for a message Hermes always answers: worth starting on before its gates have run."""
    if event.get("_slack_changed_event_ts") or event.get("_hermes_reaction") or event.get(
            "_hermes_force_process") or event.get("bot_id") or _is_marked(event):
        return False
    if str(event.get("user") or "") != settings["user"]:
        return False
    text = str(event.get("text") or "")
    if text.lstrip().startswith(("/", "!")):
        return False
    bot = getattr(adapter, "_team_bot_user_ids", {}).get(team_id) or getattr(
        adapter, "_bot_user_id", None)
    return all(user == bot for user in _MENTION.findall(text))


def _note(result: dict) -> str:
    issue, channel = result["issue"], result["channel"]
    return (
        f"[autolinear: Leon sent this in {result.get('source') or 'Slack'}. It is now "
        f"{issue['identifier']} ({issue['url']}), and this is its channel, #{channel['name']}: "
        "answer here and keep the conversation here.]")


def _add_handoff_prompt(msg_event) -> None:
    msg_event.channel_prompt = "\n\n".join(filter(None, (msg_event.channel_prompt, _HANDOFF_PROMPT)))


def _remember(adapter, team_id: str, channel_id: str, name: str) -> None:
    """Warm the adapter's caches for the new channel, so building the turn needs no lookups."""
    try:
        if team_id:
            adapter._remember_channel_team(channel_id, team_id)
        cache = getattr(adapter, "_channel_name_cache", None)
        if isinstance(cache, dict) and name:
            cache[(str(team_id or ""), channel_id)] = name
    except Exception:
        logger.debug("autolinear: could not warm caches for %s", channel_id, exc_info=True)


async def _move(adapter, settings: dict, event: dict, kwargs: dict):
    """``(event, kwargs)`` for the copy in the issue's channel, or None to answer in place."""
    channel_id = str(kwargs.get("channel_id") or "")
    ts = str(kwargs.get("ts") or "")
    team_id = str(kwargs.get("team_id") or "")
    if not channel_id or not ts:
        return None
    task = _pending(adapter).get((channel_id, ts)) or await _start(
        adapter, settings, event, channel_id, team_id)
    if task is None:
        return None
    result = await asyncio.wait_for(asyncio.shield(task), WAIT_SECONDS)
    _pending(adapter).pop((channel_id, ts), None)
    if result is None:
        return None
    new_channel, copy_ts = result["channel"]["id"], result["ts"]
    _remember(adapter, team_id, new_channel, result["channel"].get("name", ""))
    moved = {k: v for k, v in event.items() if k not in _THREAD_KEYS}
    moved.update(channel=new_channel, ts=copy_ts, event_ts=copy_ts, channel_type="group")
    moved["_autolinear"] = {
        "from_channel": channel_id, "from_ts": ts, "issue": result["issue"]["identifier"]}
    moved_kwargs = dict(kwargs)
    moved_kwargs.update(
        channel_id=new_channel, ts=copy_ts, is_dm=False,
        thread_ts=adapter._session_thread_ts(moved, copy_ts, False, {}),
        # Leon wrote it to Hermes, wherever he wrote it.
        reply_expected=True,
        text=f"{_note(result)}\n\n{kwargs.get('text') or ''}".rstrip())
    logger.info(
        "autolinear: %s:%s is %s (%s); Hermes answers in #%s", channel_id, ts,
        result["issue"]["identifier"], result.get("ms"), result["channel"].get("name", new_channel))
    return moved, moved_kwargs


def wire(native, adapter) -> None:
    """``register_platform_handler`` factory: patch this adapter instance once."""
    if getattr(adapter, _PATCHED_ATTR, False):
        return
    build = getattr(adapter, "_build_message_event", None)
    prefilter = getattr(adapter, "_prefilter_inbound", None)
    seams = (build, prefilter, getattr(adapter, "_resolve_channel_name", None),
             getattr(adapter, "_session_thread_ts", None),
             getattr(adapter, "_track_reacting_message", None),
             getattr(adapter, "_reactions_enabled", None))
    if not all(callable(seam) for seam in seams):
        logger.warning(
            "autolinear: Slack adapter internals changed; Hermes answers Leon's messages where he "
            "sends them")
        return

    @functools.wraps(prefilter)
    async def prefilter_and_start(event, *args, **kwargs):
        accepted = await prefilter(event, *args, **kwargs)
        settings = _settings()
        if accepted is None or settings is None:
            return accepted
        try:
            normalized, team_id, channel_id = accepted
            if isinstance(normalized, dict) and _answers_for_sure(
                    adapter, settings, normalized, str(team_id or "")):
                await _start(adapter, settings, normalized, str(channel_id or ""), str(team_id or ""))
        except Exception:
            logger.warning("autolinear: could not start early", exc_info=True)
        return accepted

    @functools.wraps(build)
    async def build_in_issue_channel(event, *args, **kwargs):
        settings = _settings()
        if (settings is None or not isinstance(event, dict)
                or kwargs.get("user_id") != settings["user"] or kwargs.get("is_command_text")
                or event.get("_hermes_reaction") or event.get("_hermes_force_process")
                or _is_marked(event)):
            return await build(event, *args, **kwargs)
        try:
            target = await _move(adapter, settings, event, kwargs)
        except Exception:
            logger.warning(
                "autolinear: no issue for %s:%s; answering it there",
                kwargs.get("channel_id"), kwargs.get("ts"), exc_info=True)
            target = None
        if target is None:
            msg_event = await build(event, *args, **kwargs)
            if msg_event is not None and settings["issue_channel"].match(
                    msg_event.source.chat_name or ""):
                _add_handoff_prompt(msg_event)
            return msg_event
        moved, moved_kwargs = target
        try:
            msg_event = await build(moved, *args, **moved_kwargs)
        except Exception:
            logger.warning(
                "autolinear: could not build the turn in %s; answering in place",
                moved_kwargs["channel_id"], exc_info=True)
            return await build(event, *args, **kwargs)
        if msg_event is not None:
            _add_handoff_prompt(msg_event)
        copy_ts, team_id = moved_kwargs["ts"], str(moved_kwargs.get("team_id") or "")
        try:
            # Hermes's ✅ on the copy is what marks the answer done, so it always gets the lifecycle.
            if adapter._reactions_enabled():
                adapter._track_reacting_message(team_id, copy_ts)
            # An unfurl edit of the copy must not start a second turn.
            adapter._remember_processed_message_ts(copy_ts)
        except Exception:
            logger.warning("autolinear: could not track %s", copy_ts, exc_info=True)
        return msg_event

    adapter._prefilter_inbound = prefilter_and_start
    adapter._build_message_event = build_in_issue_channel
    setattr(adapter, _PATCHED_ATTR, True)
    logger.info(
        "autolinear: each of Leon's Slack messages gets a Linear issue and channel at once%s",
        "" if _settings() else f" (off until {TOKEN_ENV} and {USER_ENV} are set)")


def register(ctx) -> None:
    ctx.register_platform_handler("slack", wire)
