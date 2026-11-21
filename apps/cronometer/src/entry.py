"""Cronometer's MCP server as a Cloudflare Python Worker.

rollecode/cronometer-mcp (pinned in pyproject.toml) runs here unchanged: its tools call
mobile.cronometer.com, the API Cronometer's Android app uses, with a blocking httpx client. This file
adds what the Mac mini's wrapper did (configs/cronometer-mcp-http) and what a Worker needs:

- the bearer token on every MCP request;
- the Cronometer login from the Worker's secrets, which upstream reads from the environment;
- the session key kept in KV between requests. Upstream caches it in a file, a Worker's files last
  only as long as one instance, and Cronometer throttles repeated logins;
- the page in www/ for a browser, as @-/ai.leonsilicon.configs.cloudflare does for the TypeScript Workers.
"""

import hmac
import os
from urllib.parse import urlparse

# Upstream keeps its session at $XDG_CACHE_HOME/cronometer-mcp/session.json, and decides that path when
# it is imported.
CACHE = "/tmp/cronometer"
os.environ["XDG_CACHE_HOME"] = CACHE

# Imported here, at the top, on purpose: when the Worker is deployed Cloudflare runs this module once
# and snapshots its memory, so everything imported at this level is already loaded when a new instance
# starts. Imported on the first request instead, upstream and the MCP SDK cost every new instance
# several seconds (measured 2026-11-21: 5 to 9 s per request).
from cronometer_mcp import server as upstream  # noqa: E402
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager  # noqa: E402
from mcp.server.transport_security import TransportSecuritySettings  # noqa: E402
from workers import Response, WorkerEntrypoint, asgi  # noqa: E402

SESSION_FILE = f"{CACHE}/cronometer-mcp/session.json"
SESSION_KEY = "session"
LOGIN = (
    "CRONOMETER_USERNAME",
    "CRONOMETER_PASSWORD",
    "CRONOMETER_TOTP_SECRET",
    "CRONOMETER_ACCOUNT_TZ",
)

_app = None
# The session as this instance last saw it in KV.
_known = None


def _local_session():
    try:
        with open(SESSION_FILE, encoding="utf-8") as fh:
            return fh.read()
    except OSError:
        return None


def _adopt_session(saved):
    if saved is None:
        try:
            os.remove(SESSION_FILE)
        except OSError:
            pass
        return
    os.makedirs(os.path.dirname(SESSION_FILE), exist_ok=True)
    with open(SESSION_FILE, "w", encoding="utf-8") as fh:
        fh.write(saved)


def _build_app(env):
    """Gives upstream its login and returns an ASGI app that serves one MCP request."""
    for name in LOGIN:
        value = getattr(env, name, None)
        if value:
            os.environ[name] = str(value)

    host = str(env.CRONOMETER_HTTP_PUBLIC_HOST)
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=[host, f"{host}:*"],
        allowed_origins=[],
    )

    async def app(scope, receive, send):
        if scope["type"] == "lifespan":
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        # The Worker's ASGI adapter starts the app's lifespan on every request, and this SDK's session
        # manager can run once, so each request gets its own. Stateless: nothing is kept between them.
        manager = StreamableHTTPSessionManager(
            app=upstream.mcp._mcp_server,
            json_response=True,
            stateless=True,
            security_settings=security,
        )
        async with manager.run():
            await manager.handle_request(scope, receive, send)

    return app


def _site_path(host):
    """The www/ directory of a hostname: its labels reversed (cronometer.leonsilicon.ai is /ai/leonsilicon/cronometer/)."""
    labels = host.lower().split(":")[0].rstrip(".").split(".")
    if len(labels) < 2 or not all(label.replace("-", "").isalnum() for label in labels):
        return None
    return "/" + "/".join(reversed(labels)) + "/"


async def _page(request, env, url):
    """The built page for a browser, or None for everything else."""
    if request.method not in ("GET", "HEAD"):
        return None
    if url.path.startswith("/assets/"):
        path = url.path
    elif "text/html" in (request.headers.get("accept") or ""):
        root = _site_path(url.netloc)
        if root is None:
            return None
        path = root + url.path[1:] + ("index.html" if url.path.endswith("/") else "")
    else:
        return None
    response = await env.ASSETS.fetch(f"{url.scheme}://{url.netloc}{path}")
    return None if response.status == 404 else response


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        global _app, _known
        env = self.env
        url = urlparse(request.url)
        if url.path == "/healthz":
            return Response.json({"ok": True})
        page = await _page(request, env, url)
        if page is not None:
            return page
        if url.path not in ("/", "/mcp"):
            return Response.json({"error": "not_found"}, status=404)

        header = request.headers.get("authorization") or ""
        scheme, _, presented = header.partition(" ")
        expected = str(env.CRONOMETER_HTTP_TOKEN)
        if (
            len(expected) < 32
            or scheme.lower() != "bearer"
            or not hmac.compare_digest(presented.strip().encode(), expected.encode())
        ):
            print(f"401 {request.method} {url.path}")
            return Response.json(
                {"error": "unauthorized"}, status=401, headers={"www-authenticate": "Bearer"}
            )

        saved = await env.SESSION.get(SESSION_KEY)
        saved = saved if isinstance(saved, str) else None
        if _app is None:
            _adopt_session(saved)
            _known = saved
            _app = _build_app(env)
        elif saved != _known:
            # Another instance signed in since: take its session rather than sign in again.
            _adopt_session(saved)
            _known = saved
            upstream._client = None

        response = await asgi.fetch(_app, request, env)

        # Upstream wrote a new session file if it had to sign in, and removed it if the key was refused.
        current = _local_session()
        if current != _known:
            if current is None:
                await env.SESSION.delete(SESSION_KEY)
            else:
                await env.SESSION.put(SESSION_KEY, current)
            _known = current
            print("session saved" if current else "session dropped")
        return response
