#!/usr/bin/env python3
"""Token-protected Streamable HTTP front for rollecode/cronometer-mcp on Leon's Mac mini.

Cloud agents (Grok Bots, Hermes Cloud) can't spawn a stdio server, so this
process serves rollecode/cronometer-mcp's tools over HTTP:

    https://cronometer.leonsilicon.ai (ai-edge Worker -> ai-gateway on the mini)
      -> http://127.0.0.1:18791/mcp  (this file, run by cronometer-mcp's venv python)
      -> cronometer_mcp (pinned checkout) -> mobile.cronometer.com

The Cronometer login never leaves the mini (~/.config/cronometer-mcp/env, mode
600), and the session token Cronometer hands back is cached by upstream in
~/.cache/cronometer-mcp/session.json. Compared with upstream's own HTTP mode:
  - the bearer check runs in this process, so upstream's Node auth-server and
    nginx aren't needed (and no OAuth login page is exposed);
  - FastMCP's Host check allows the public host (CRONOMETER_HTTP_PUBLIC_HOST), which
    upstream's localhost-only defaults would reject with 421.

Environment (all optional):
  CRONOMETER_HTTP_TOKEN_FILE   default ~/.config/cronometer-mcp-http/token
  CRONOMETER_HTTP_ENV_FILE     default ~/.config/cronometer-mcp/env
                               (CRONOMETER_USERNAME, CRONOMETER_PASSWORD, optional
                               CRONOMETER_TOTP_SECRET and CRONOMETER_ACCOUNT_TZ)
  CRONOMETER_HTTP_PORT         default 18791
  CRONOMETER_HTTP_PUBLIC_HOST  default cronometer.leonsilicon.ai
"""

import hmac
import json
import logging
import os
import sys
from typing import Any, Iterable, Tuple

from dotenv import load_dotenv

TOKEN_FILE = os.path.expanduser(os.environ.get("CRONOMETER_HTTP_TOKEN_FILE", "~/.config/cronometer-mcp-http/token"))
ENV_FILE = os.path.expanduser(os.environ.get("CRONOMETER_HTTP_ENV_FILE", "~/.config/cronometer-mcp/env"))
PORT = int(os.environ.get("CRONOMETER_HTTP_PORT", "18791"))
PUBLIC_HOST = os.environ.get("CRONOMETER_HTTP_PUBLIC_HOST", "cronometer.leonsilicon.ai")

# Upstream reads the login from the environment when it first logs in. Real
# environment variables win over the file.
load_dotenv(ENV_FILE, override=False)

import uvicorn  # noqa: E402
from cronometer_mcp.server import mcp  # noqa: E402
from mcp.server.transport_security import TransportSecuritySettings  # noqa: E402

log = logging.getLogger("cronometer-mcp-http")

mcp.settings.transport_security = TransportSecuritySettings(
    enable_dns_rebinding_protection=True,
    allowed_hosts=[PUBLIC_HOST, f"{PUBLIC_HOST}:*", "127.0.0.1:*", "localhost:*"],
    allowed_origins=[],
)


def load_token(path: str = TOKEN_FILE) -> bytes:
    with open(path, encoding="utf-8") as fh:
        token = fh.read().strip()
    if len(token) < 32:
        raise SystemExit(f"{path} must hold a token of at least 32 characters")
    return token.encode()


async def _reply(send: Any, status: int, body: dict, headers: Iterable[Tuple[bytes, bytes]] = ()) -> None:
    data = json.dumps(body).encode()
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(data)).encode()), *headers],
    })
    await send({"type": "http.response.body", "body": data})


class BearerAuth:
    """Reject every HTTP request without the exact bearer token; /healthz is open (local only)."""

    def __init__(self, app: Any, token: bytes) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] == "http":
            if scope["path"] == "/healthz":
                await _reply(send, 200, {"ok": True})
                return
            header = dict(scope.get("headers") or []).get(b"authorization", b"")
            scheme, _, presented = header.partition(b" ")
            if scheme.lower() != b"bearer" or not hmac.compare_digest(presented.strip(), self.token):
                client = (scope.get("client") or ("?",))[0]
                log.warning("401 %s %s from %s", scope.get("method"), scope["path"], client)
                await _reply(send, 401, {"error": "unauthorized"}, [(b"www-authenticate", b"Bearer")])
                return
        await self.app(scope, receive, send)


def build_app(token: bytes) -> BearerAuth:
    return BearerAuth(mcp.streamable_http_app(), token)


def main() -> None:
    # force=True: upstream calls logging.basicConfig() at import time.
    logging.basicConfig(stream=sys.stdout, level=logging.INFO, force=True,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = build_app(load_token())
    if not (os.environ.get("CRONOMETER_USERNAME") and os.environ.get("CRONOMETER_PASSWORD")):
        log.warning("no Cronometer login in %s yet: tool calls will fail until it is added", ENV_FILE)
    log.info("listening on http://127.0.0.1:%d/mcp (public host %s)", PORT, PUBLIC_HOST)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
