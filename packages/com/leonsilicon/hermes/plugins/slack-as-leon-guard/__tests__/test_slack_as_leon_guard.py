"""Run against a Hermes checkout (see README): uses the real v0.23 Slack adapter."""

from __future__ import annotations

import importlib.util
import pathlib
import re
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import PlatformConfig
from plugins.platforms.slack.adapter import SlackAdapter

_root = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("slack_as_leon_guard", _root / "__init__.py")
plugin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plugin)

LEON = "U0LEON00001"
MARKED = "de1e6a7e-ccdc-45d1-94bb-f80359112347"
LEONS_OWN = "3f2b1c4d-1111-4222-8333-944455556666"


@pytest.fixture()
def adapter(monkeypatch):
    monkeypatch.setenv("SLACK_REQUIRE_MENTION", "false")
    a = SlackAdapter(PlatformConfig(enabled=True, token="***"))
    a._app = MagicMock()
    a._app.client = AsyncMock()
    a._app.client.users_info = AsyncMock(
        return_value={"user": {"is_bot": False, "profile": {"display_name": "Leon"}}})
    a._bot_user_id = "U_HERMES"
    a._running = True
    a.handle_message = AsyncMock()
    return a


def _event(ts: str, client_msg_id: str, **extra) -> dict:
    return {"type": "message", "text": "add milk to my list", "user": LEON, "channel": "C_TODO",
            "channel_type": "channel", "ts": ts, "client_msg_id": client_msg_id, **extra}


def test_marker_matches_the_mini_service():
    """The TypeScript service's CLIENT_MSG_ID_PREFIX must equal MARKER."""
    marker_ts = (_root.parents[3] / "leonsilicon/ai/services/slack-as-leon/marker.ts").read_text()
    match = re.search(r'CLIENT_MSG_ID_PREFIX = "([0-9a-f]{8})"', marker_ts)
    assert match and match.group(1) == plugin.MARKER


@pytest.mark.asyncio
async def test_stock_adapter_answers_a_post_made_as_leon(adapter):
    """Documents the loop this plugin prevents."""
    await adapter._handle_slack_message(_event("1700000000.000001", MARKED))
    adapter.handle_message.assert_awaited_once()


@pytest.mark.asyncio
async def test_post_made_as_leon_is_ignored(adapter):
    plugin.wire(None, adapter)
    await adapter._handle_slack_message(_event("1700000000.000002", MARKED))
    await adapter._handle_slack_message(
        _event("1700000000.000003", MARKED, thread_ts="1700000000.000001"))
    adapter.handle_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_mention_of_hermes_in_a_post_made_as_leon_is_ignored(adapter):
    plugin.wire(None, adapter)
    event = _event("1700000000.000004", MARKED, text="<@U_HERMES> can you check this")
    await adapter._handle_slack_message(event)
    await adapter._handle_slack_message({**event, "type": "app_mention"})
    adapter.handle_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_edit_of_a_post_made_as_leon_is_ignored(adapter):
    plugin.wire(None, adapter)
    original = _event("1700000000.000005", MARKED, text="<@U_HERMES> fixed typo")
    await adapter._handle_slack_message({
        "type": "message", "subtype": "message_changed", "channel": "C_TODO",
        "channel_type": "channel", "ts": "1700000009.000001", "event_ts": "1700000009.000001",
        "message": {**original, "edited": {"user": LEON, "ts": "1700000009.000001"}}})
    adapter.handle_message.assert_not_awaited()


@pytest.mark.asyncio
async def test_leons_own_messages_still_reach_hermes(adapter):
    plugin.wire(None, adapter)
    await adapter._handle_slack_message(_event("1700000000.000006", LEONS_OWN))
    await adapter._handle_slack_message(
        {k: v for k, v in _event("1700000000.000007", "").items() if k != "client_msg_id"})
    assert adapter.handle_message.await_count == 2


def test_wire_is_idempotent_and_fails_closed(adapter, caplog):
    plugin.wire(None, adapter)
    wrapped = adapter._prefilter_inbound
    plugin.wire(None, adapter)
    assert adapter._prefilter_inbound is wrapped

    bare = MagicMock(spec=[])
    with caplog.at_level("WARNING"):
        plugin.wire(None, bare)
    assert "internals changed" in caplog.text


def test_is_marked():
    assert plugin.is_marked({"client_msg_id": MARKED})
    assert plugin.is_marked({"subtype": "message_changed", "message": {"client_msg_id": MARKED}})
    assert not plugin.is_marked({"client_msg_id": LEONS_OWN})
    assert not plugin.is_marked({"client_msg_id": "de1e6a7e"})
    assert not plugin.is_marked({})
    assert not plugin.is_marked(None)
