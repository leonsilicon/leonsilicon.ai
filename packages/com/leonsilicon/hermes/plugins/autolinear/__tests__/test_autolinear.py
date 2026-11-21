"""Run against a Hermes checkout with its environment (see README): it drives the real Slack adapter."""

from __future__ import annotations

import importlib.util
import pathlib
import urllib.error
from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import PlatformConfig
from gateway.platforms.event import MessageType, ProcessingOutcome
from plugins.platforms.slack.adapter import SlackAdapter

_HERE = pathlib.Path(__file__).resolve().parents[1]


def _load(name: str, path: pathlib.Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = _load("autolinear", _HERE / "__init__.py")
guard = _load("slack_as_leon_guard", _HERE.parent / "slack-as-leon-guard" / "__init__.py")
always_react = _load("slack_always_react", _HERE.parent / "slack-always-react" / "__init__.py")

LEON, HERMES = "U0LEON00001", "U0HERMES001"
DM, GENERAL, ISSUE, NEW = "D0LEONDM01", "C0GENERAL1", "C0ISSUE001", "C0NEWISSUE"
COPY_TS = "1794000000.000900"
CHANNELS = {
    DM: {"id": DM, "is_im": True, "user": LEON},
    GENERAL: {"id": GENERAL, "name": "general"},
    ISSUE: {"id": ISSUE, "name": "leon-12-fix-the-printer"},
    NEW: {"id": NEW, "name": "leon-401-check-rogers"},
}
RESULT = {
    "ok": True,
    "issue": {"id": "i-401", "identifier": "LEON-401", "url": "https://linear.app/x/issue/LEON-401"},
    "channel": {"id": NEW, "name": "leon-401-check-rogers"},
    "ts": COPY_TS,
    "source": "a DM with Hermes",
}


class Intake:
    """autolinear's /intake: records requests and answers from a script of (status, body) or errors."""

    def __init__(self, *answers):
        self.answers = list(answers) or [(200, RESULT)]
        self.requests: list[dict] = []

    def __call__(self, url, token, payload, timeout):
        self.requests.append({"url": url, "token": token, **payload})
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, BaseException):
            raise answer
        return answer


@pytest.fixture()
def intake(monkeypatch):
    fake = Intake()
    monkeypatch.setattr(plugin, "_post_json", fake)
    monkeypatch.setattr(plugin, "RETRY_DELAY_SECONDS", 0)
    return fake


@pytest.fixture()
def adapter(monkeypatch):
    monkeypatch.setenv("SLACK_REQUIRE_MENTION", "false")
    monkeypatch.setenv(plugin.TOKEN_ENV, "autolinear-token")
    monkeypatch.setenv(plugin.USER_ENV, LEON)
    a = SlackAdapter(PlatformConfig(enabled=True, token="***"))
    a._app = MagicMock()
    a._app.client = AsyncMock()
    a._app.client.users_info = AsyncMock(
        return_value={"ok": True, "user": {"is_bot": False, "profile": {"display_name": "Leon"}}})

    async def info(channel, **_):
        return {"ok": True, "channel": CHANNELS[channel]}

    a._app.client.conversations_info = AsyncMock(side_effect=info)
    a._app.client.reactions_add = AsyncMock()
    a._app.client.reactions_remove = AsyncMock()
    a._bot_user_id = "U_BOT"
    a._running = True
    a.handle_message = AsyncMock()
    return a


def _message(channel: str, ts: str, text: str = "can you check whether Rogers billed me twice?",
             user: str = LEON, **extra) -> dict:
    channel_type = {"D": "im", "C": "channel"}[channel[0]]
    return {"type": "message", "text": text, "user": user, "channel": channel,
            "channel_type": channel_type, "ts": ts,
            "client_msg_id": f"6a1c7d1e-0000-4000-8000-{ts.replace('.', '')[-12:]}", **extra}


def _turn(adapter):
    adapter.handle_message.assert_awaited_once()
    return adapter.handle_message.await_args.args[0]


@pytest.mark.asyncio
async def test_leons_dm_is_answered_in_its_new_issue_channel(adapter, intake):
    plugin.wire(None, adapter)
    ts = "1794000000.000001"
    await adapter._handle_slack_message(_message(DM, ts))

    assert intake.requests == [{
        "url": plugin.DEFAULT_URL, "token": "autolinear-token", "channel": DM, "ts": ts,
        "thread_ts": None, "user": LEON, "text": "can you check whether Rogers billed me twice?",
        "where": "a DM with Hermes"}]
    turn = _turn(adapter)
    assert (turn.source.chat_id, turn.source.chat_type) == (NEW, "group")
    assert turn.source.chat_name == "leon-401-check-rogers"
    assert turn.source.user_id == LEON
    assert turn.message_id == turn.source.message_id == COPY_TS
    assert turn.source.thread_id == COPY_TS  # reply_in_thread, as in any channel
    assert turn.reply_to_message_id is None
    assert turn.reply_expected is True
    assert turn.text.startswith(
        "[autolinear: Leon sent this in a DM with Hermes. It is now LEON-401 "
        "(https://linear.app/x/issue/LEON-401), and this is its channel, #leon-401-check-rogers")
    assert turn.text.endswith("\n\ncan you check whether Rogers billed me twice?")
    assert turn.channel_prompt.endswith(plugin._HANDOFF_PROMPT)
    assert turn.raw_message["channel"] == NEW and turn.raw_message["ts"] == COPY_TS
    assert turn.raw_message["_autolinear"] == {
        "from_channel": DM, "from_ts": ts, "issue": "LEON-401"}

    # 👀 and ✅ land on the copy in the issue channel: that is what moves the issue.
    await adapter.on_processing_start(turn)
    await adapter.on_processing_complete(turn, ProcessingOutcome.SUCCESS)
    added = [(c.kwargs["channel"], c.kwargs["timestamp"], c.kwargs["name"])
             for c in adapter._app.client.reactions_add.call_args_list]
    assert added == [(NEW, COPY_TS, "eyes"), (NEW, COPY_TS, "white_check_mark")]


@pytest.mark.asyncio
async def test_a_thread_reply_keeps_its_thread_context(adapter, intake):
    plugin.wire(None, adapter)
    root = "1794000000.000010"
    adapter._app.client.conversations_replies = AsyncMock(return_value={"ok": True, "messages": [
        {"ts": root, "user": HERMES, "text": "Want me to file the T4 now or wait?"},
        {"ts": "1794000000.000011", "user": LEON, "text": "wait for the slip", "thread_ts": root},
    ]})
    await adapter._handle_slack_message(
        _message(GENERAL, "1794000000.000011", "wait for the slip", thread_ts=root))

    assert intake.requests[0]["thread_ts"] == root
    assert intake.requests[0]["where"] == "a thread in #general"
    turn = _turn(adapter)
    assert turn.source.chat_id == NEW
    assert turn.source.thread_id == COPY_TS, "the copy starts its own thread in the issue channel"
    assert "thread_ts" not in turn.raw_message
    assert turn.channel_context and "file the T4" in turn.channel_context


@pytest.mark.parametrize("event", [
    _message(GENERAL, "1794000000.000021", user="U0SOMEONE1"),  # not Leon
    _message(ISSUE, "1794000000.000022", "/new"),  # a command in an issue channel
])
@pytest.mark.asyncio
async def test_other_users_and_commands_are_answered_in_place(adapter, intake, event):
    plugin.wire(None, adapter)
    await adapter._handle_slack_message(dict(event))
    assert intake.requests == []
    turn = _turn(adapter)
    assert turn.source.chat_id == event["channel"]
    assert plugin._HANDOFF_PROMPT not in (turn.channel_prompt or "")


@pytest.mark.asyncio
async def test_an_existing_issue_keeps_its_message_and_gets_the_handoff_rule(adapter, intake):
    adapter.config.extra["channel_prompts"] = {ISSUE: "Keep the question brief."}
    plugin.wire(None, adapter)
    await adapter._handle_slack_message(_message(ISSUE, "1794000000.000020", "Show me the draft."))

    assert intake.requests == []
    turn = _turn(adapter)
    assert turn.source.chat_id == ISSUE
    assert turn.text == "Show me the draft."
    assert turn.channel_prompt == f"Keep the question brief.\n\n{plugin._HANDOFF_PROMPT}"


@pytest.mark.parametrize("answers", [
    [(200, {"ok": False, "skipped": "issue_channel"})],
    [(401, {"error": "unauthorized"})],
    [urllib.error.URLError("down"), urllib.error.URLError("still down")],
    [(503, {}), (503, {})],
])
@pytest.mark.asyncio
async def test_when_linear_sync_declines_or_fails_hermes_answers_in_place(
        adapter, intake, answers):
    intake.answers = answers
    plugin.wire(None, adapter)
    await adapter._handle_slack_message(_message(DM, "1794000000.000030"))
    turn = _turn(adapter)
    assert turn.source.chat_id == DM
    assert turn.text == "can you check whether Rogers billed me twice?"


@pytest.mark.asyncio
async def test_a_failed_try_is_retried_once(adapter, intake):
    intake.answers = [urllib.error.URLError("blip"), (200, RESULT)]
    plugin.wire(None, adapter)
    await adapter._handle_slack_message(_message(DM, "1794000000.000031"))
    assert len(intake.requests) == 2
    assert _turn(adapter).source.chat_id == NEW


@pytest.mark.asyncio
async def test_off_without_its_token(adapter, intake, monkeypatch):
    monkeypatch.delenv(plugin.TOKEN_ENV)
    plugin.wire(None, adapter)
    await adapter._handle_slack_message(_message(DM, "1794000000.000040"))
    assert intake.requests == []
    assert _turn(adapter).source.chat_id == DM


@pytest.mark.asyncio
async def test_skipped_channels_are_answered_in_place(adapter, intake, monkeypatch):
    monkeypatch.setenv(plugin.SKIP_ENV, f"C0OTHER001, {GENERAL}")
    plugin.wire(None, adapter)
    await adapter._handle_slack_message(_message(GENERAL, "1794000000.000041"))
    assert intake.requests == []


@pytest.mark.asyncio
async def test_the_link_edit_and_the_live_copy_start_no_second_turn(adapter, intake):
    guard.wire(None, adapter)
    plugin.wire(None, adapter)
    ts = "1794000000.000050"
    await adapter._handle_slack_message(_message(DM, ts))

    # AutoLinear replaces Leon's message with the channel link.
    await adapter._handle_slack_message({
        "type": "message", "subtype": "message_changed", "channel": DM, "channel_type": "im",
        "ts": "1794000001.000001",
        "message": {**_message(DM, ts), "text": f"<#{NEW}>",
                    "edited": {"user": LEON, "ts": "1794000001.000001"}}})
    # Its copy in the issue channel, posted as Leon with slack-as-leon's marker, and its unfurl.
    copy = {**_message(NEW, COPY_TS), "channel_type": "group",
            "client_msg_id": "de1e6a7e-1111-4000-8000-000000000001"}
    await adapter._handle_slack_message(copy)
    await adapter._handle_slack_message({
        "type": "message", "subtype": "message_changed", "channel": NEW, "channel_type": "group",
        "ts": "1794000001.000002", "message": {**copy, "attachments": [{"title": "unfurl"}]}})

    adapter.handle_message.assert_awaited_once()
    assert len(intake.requests) == 1


@pytest.mark.parametrize("react_first", [True, False])
@pytest.mark.asyncio
async def test_the_copy_gets_reactions_whichever_plugin_wires_first(adapter, intake, react_first):
    for module in ((always_react, plugin) if react_first else (plugin, always_react)):
        module.wire(None, adapter)
    await adapter._handle_slack_message(_message(GENERAL, "1794000000.000060"))
    turn = _turn(adapter)
    assert adapter._reacting_target(turn) is not None
    assert turn.message_type == MessageType.TEXT


def test_wire_is_idempotent(adapter):
    plugin.wire(None, adapter)
    patched = adapter._build_message_event
    plugin.wire(None, adapter)
    assert adapter._build_message_event is patched


def test_missing_internals_fail_closed(caplog):
    class Bare:
        pass

    bare = Bare()
    plugin.wire(None, bare)
    assert not hasattr(bare, "_build_message_event")
    assert "internals changed" in caplog.text


@pytest.mark.asyncio
async def test_the_intake_starts_before_hermes_reads_the_thread_or_files(adapter, intake):
    plugin.wire(None, adapter)
    started_first = []
    hydrate = adapter._hydrate_thread_context

    async def hydrate_and_check(**kwargs):
        started_first.append((kwargs["channel_id"], kwargs["ts"]) in adapter._autolinear_pending)
        return await hydrate(**kwargs)

    adapter._hydrate_thread_context = hydrate_and_check
    await adapter._handle_slack_message(_message(DM, "1794000000.000070", files=[
        {"name": "a.png", "title": "receipt.png", "permalink": "https://files.slack.com/F1",
         "url_private": "https://files.slack.com/F1/a.png", "mimetype": "image/png"}]))
    assert started_first == [True]
    assert intake.requests[0]["files"] == [
        {"name": "a.png", "title": "receipt.png", "permalink": "https://files.slack.com/F1"}]
    assert _turn(adapter).source.chat_id == NEW
    assert not adapter._autolinear_pending, "taken by the turn"


@pytest.mark.asyncio
async def test_a_message_mentioning_someone_else_starts_only_once_hermes_answers_it(
        adapter, intake):
    plugin.wire(None, adapter)
    started_first = []
    hydrate = adapter._hydrate_thread_context

    async def hydrate_and_check(**kwargs):
        started_first.append(bool(intake.requests))
        return await hydrate(**kwargs)

    adapter._hydrate_thread_context = hydrate_and_check
    await adapter._handle_slack_message(
        _message(DM, "1794000000.000071", f"ask <@U0SOMEONE1> about it, <@U_BOT>"))
    assert started_first == [False]
    assert len(intake.requests) == 1
    assert _turn(adapter).source.chat_id == NEW
