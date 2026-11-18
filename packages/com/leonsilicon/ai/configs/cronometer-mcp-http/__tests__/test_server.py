"""Offline tests for server.py: the bearer gate and the Funnel Host allowance.

Run on the mini with cronometer-mcp's venv python (needs pytest there):
    ~/.local/share/cronometer-mcp/.venv/bin/python -m pytest __tests__ -q
No Cronometer login is needed: listing tools never calls Cronometer.
"""

import os
import sys

import pytest
from starlette.testclient import TestClient

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
os.environ.setdefault("CRONOMETER_HTTP_ENV_FILE", os.path.join(HERE, "missing.env"))

import server  # noqa: E402

TOKEN = "t" * 40
HEADERS = {
    "accept": "application/json, text/event-stream",
    "content-type": "application/json",
    "host": server.PUBLIC_HOST,
}
INIT = {
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
}


@pytest.fixture(scope="module")
def client():
    with TestClient(server.build_app(TOKEN.encode()), base_url=f"https://{server.PUBLIC_HOST}") as c:
        yield c


def test_healthz_is_open(client):
    assert client.get("/healthz").json() == {"ok": True}


@pytest.mark.parametrize("auth", [None, "Bearer wrong", f"Basic {TOKEN}", f"Bearer {TOKEN}x"])
def test_rejects_missing_or_wrong_token(client, auth):
    headers = dict(HEADERS)
    if auth:
        headers["authorization"] = auth
    resp = client.post("/mcp", json=INIT, headers=headers)
    assert resp.status_code == 401
    assert resp.headers["www-authenticate"] == "Bearer"


def _rpc(client, body, session=None):
    headers = {**HEADERS, "authorization": f"Bearer {TOKEN}"}
    if session:
        headers["mcp-session-id"] = session
    return client.post("/mcp", json=body, headers=headers)


def _json(resp):
    if resp.headers["content-type"].startswith("text/event-stream"):
        import json
        data = [line[5:].strip() for line in resp.text.splitlines() if line.startswith("data:")]
        return json.loads(data[-1])
    return resp.json()


def test_token_and_funnel_host_reach_the_tools(client):
    resp = _rpc(client, INIT)
    assert resp.status_code == 200, resp.text
    session = resp.headers.get("mcp-session-id")
    _rpc(client, {"jsonrpc": "2.0", "method": "notifications/initialized"}, session)
    tools = _json(_rpc(client, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, session))
    names = {t["name"] for t in tools["result"]["tools"]}
    assert {"search_foods", "add_food_entry", "get_food_log", "add_biometric"} <= names


def test_unknown_host_is_refused(client):
    headers = {**HEADERS, "authorization": f"Bearer {TOKEN}", "host": "evil.example"}
    assert client.post("/mcp", json=INIT, headers=headers).status_code in (400, 421)
