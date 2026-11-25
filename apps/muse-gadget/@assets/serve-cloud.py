"""Run Meta's Gadget registration and private muse-mcp on the same machine."""
from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
import sys

ROOT = Path(os.environ.get("HERMES_MUSE_GADGET_DIR", "/opt/data/muse-gadget"))
STATE = ROOT / "state"
os.environ["MUSEGADGET_STATE_DIR"] = str(STATE)
os.environ["SIDECHAT_DIRECTORY_FILE"] = str(ROOT / "directory.json")
os.environ["SIDECHAT_AUDIT_LOG"] = str(ROOT / "mcp-audit.log")
os.environ["BIND_HOST"] = "127.0.0.1"
sys.path.insert(0, str(ROOT / "muse-mcp"))

import server as muse_mcp

# hermes22muse sends Muse the user's own words, so this private server leaves out muse-mcp's
# provenance stamp ("⟦via muse-mcp · from …⟧ ") on everything it sends.
muse_mcp._stamped = lambda caller, text: text

import uvicorn
from musegadget import config, identity
from musegadget.service import Service


class NoHostCommands:
    def specs(self, **kwargs):
        return {}

    def run(self, name, params, timeout_ms=None):
        return {"ok": False, "error": "unsupported command"}


async def main():
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
