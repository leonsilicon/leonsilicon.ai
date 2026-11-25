"""Run Meta's Gadget registration and private muse-mcp on the same machine."""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
import sys

ROOT = Path(os.environ.get("HERMES_MUSE_GADGET_DIR", "/opt/data/muse-gadget"))
STATE = ROOT / "state"


def _approval_chat(approval):
    if not isinstance(approval, dict):
        return None
    scope = approval.get("scope") if isinstance(approval.get("scope"), dict) else {}
    trace = approval.get("runtime_request_trace")
    scope_trace = scope.get("runtime_request_trace")
    thread = scope.get("thread")
    session = scope.get("session")
    candidates = (
        trace.get("thread_id") if isinstance(trace, dict) else None,
        trace.get("session_id") if isinstance(trace, dict) else None,
        scope_trace.get("thread_id") if isinstance(scope_trace, dict) else None,
        scope_trace.get("session_id") if isinstance(scope_trace, dict) else None,
        approval.get("thread_id"),
        approval.get("session_id"),
        scope.get("thread_id"),
        scope.get("session_id"),
        thread.get("id") if isinstance(thread, dict) else None,
        session.get("id") if isinstance(session, dict) else None,
    )
    for value in candidates:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _event_matches_chat(payload, chat_id):
    if payload.get("is_thread") is False:
        return False
    for key in ("thread_id", "session_id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip() and value.strip() != chat_id:
            return False
    return True


def _scoped_live_from_events(events, chat_id):
    """Filter Muse's account-wide approvals.snapshot and status events to chat_id."""
    agent_code = agent_text = task_status = subagents = pending = None
    snapshot_received = False
    for ev in events:
        name = ev.get("event")
        payload = ev.get("payload")
        if not isinstance(payload, dict):
            continue
        if name == "agent.status" and _event_matches_chat(payload, chat_id):
            snapshot_received = True
            agent_code = payload.get("activity_code")
            agent_text = payload.get("activity_text")
        elif name == "task.status" and _event_matches_chat(payload, chat_id):
            snapshot_received = True
            task_status = payload.get("status")
            subagents = payload.get("active_subagent_count")
        elif name == "approvals.snapshot":
            snapshot_received = True
            approvals = payload.get("pending_approvals")
            if approvals is None:
                approvals = payload.get("pending")
            if isinstance(approvals, list):
                pending = sum(
                    1
                    for item in approvals
                    if isinstance(item, dict)
                    and (item.get("status") or "pending") == "pending"
                    and _approval_chat(item) == chat_id
                )
            else:
                pending = None
    return {
        "agent_activity_code": agent_code,
        "agent_activity_text": agent_text,
        "task_status": task_status,
        "active_subagent_count": subagents,
        "pending_approval_count": pending,
        "pending_approvals_scoped": True,
        "snapshot_received": snapshot_received,
    }


def configure_muse_mcp(muse_mcp):
    # hermes22muse sends Muse the user's own words, so this private server leaves out muse-mcp's
    # provenance stamp ("⟦via muse-mcp · from …⟧ ") on everything it sends.
    muse_mcp._stamped = lambda caller, text: text
    # Muse's approvals.snapshot lists pending approvals for every chat in the account; count only
    # the approvals that belong to the requested chat so another side chat never blocks it.
    muse_mcp._live_from_events = _scoped_live_from_events


class NoHostCommands:
    def specs(self, **kwargs):
        return {}

    def run(self, name, params, timeout_ms=None):
        return {"ok": False, "error": "unsupported command"}


async def main():
    os.environ["MUSEGADGET_STATE_DIR"] = str(STATE)
    os.environ["SIDECHAT_DIRECTORY_FILE"] = str(ROOT / "directory.json")
    os.environ["SIDECHAT_AUDIT_LOG"] = str(ROOT / "mcp-audit.log")
    os.environ["BIND_HOST"] = "127.0.0.1"
    sys.path.insert(0, str(ROOT / "muse-mcp"))

    import server as muse_mcp
    import uvicorn
    from musegadget import config, identity
    from musegadget.service import Service

    configure_muse_mcp(muse_mcp)
    logging.basicConfig(level=logging.INFO)
    logging.getLogger("websockets").setLevel(logging.WARNING)
    pairing = config.load_json(config.PAIRING_FILE)
    if config.pairing_problem(pairing):
        raise SystemExit("The Gadget needs a saved Muse pairing")
    sdk_token = config.sdk_token()
    if not sdk_token:
        raise SystemExit("The Gadget SDK token is missing")
    secret = (STATE / "origin-secret").read_text().strip()
    if len(secret) < 32:
        raise SystemExit("The MCP origin secret is missing or invalid")

    gadget = Service(
        identity=identity.load_or_create(),
        executor=NoHostCommands(),
        sdk_token=sdk_token,
        display_name="Hermes Cloud",
        guide=None,
    )
    app = muse_mcp._OriginSecretGuard(muse_mcp.mcp.streamable_http_app(
        transport_security=muse_mcp.TRANSPORT_SECURITY,
        host="127.0.0.1",
    ), secret)
    mcp = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=7899, access_log=False))
    async with asyncio.TaskGroup() as tasks:
        tasks.create_task(gadget.run())
        try:
            await mcp.serve()
        finally:
            gadget.stop()


if __name__ == "__main__":
    asyncio.run(main())
