from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import asyncio

MODULE = Path(__file__).resolve().parents[1] / "slack_work" / "__init__.py"
spec = importlib.util.spec_from_file_location("slack_work", MODULE)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)

CHANNEL = "CTASK"
THREAD = "1700000000.000001"
MESSAGE = "1700000000.000002"


def test_hermes_and_orca_share_the_thread_indicator():
    asyncio.run(check_thread_indicator())


async def check_thread_indicator():
    client = SimpleNamespace(api_call=AsyncMock())
    orca = SimpleNamespace(active_routes=lambda: {("TWORK", CHANNEL, THREAD)})
    adapter = SimpleNamespace(_outbound_blocked=lambda *_: False, _get_client=lambda *_a, **_kw: client,
                              _slack22orca_relay=SimpleNamespace(store=orca))
    work = plugin.Work(adapter)
    event = SimpleNamespace(message_id=MESSAGE, source=SimpleNamespace(
        scope_id="TWORK", chat_id=CHANNEL, thread_id=THREAD,
    ))

    work.start(event)
    await work.render(work.active())
    assert client.api_call.await_args.kwargs["json"]["status"] == "is working on it…"
    work.end(event)
    assert work.finished == {CHANNEL}
    await work.render(work.active())
    assert client.api_call.await_count == 1

    orca.active_routes = set
    await work.render(work.active())
    assert client.api_call.await_count == 2
    assert client.api_call.await_args.kwargs["json"]["status"] == ""

def test_unobservable_runner_handoffs_are_recognized():
    assert plugin.unobserved_handoff("mcp_inbox_grok_bot_send", {})
    assert plugin.unobserved_handoff("muse_handoff", {})
    assert plugin.unobserved_handoff("mcp_inbox_send_message", {
        "slack_channel": CHANNEL, "slack_thread_ts": THREAD,
    })
    assert not plugin.unobserved_handoff("mcp_inbox_send_message", {"text": "ordinary message"})
    assert not plugin.unobserved_handoff("slack22orca_delegate", {})
