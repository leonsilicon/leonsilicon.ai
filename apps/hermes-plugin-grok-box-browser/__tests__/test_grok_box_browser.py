import abc
import importlib.util
import io
import json
import os
import socket
import sys
import threading
import types
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

path = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("grok_box_browser", path / "__init__.py")
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
call = sys.modules["grok_box_browser._pythonmonkey"].call


class BrowserProvider(abc.ABC):
    """Stand-in for agent.browser_provider.BrowserProvider."""

    @property
    @abc.abstractmethod
    def name(self): ...

    @abc.abstractmethod
    def is_available(self): ...

    @abc.abstractmethod
    def create_session(self, task_id): ...

    @abc.abstractmethod
    def close_session(self, session_id): ...

    @abc.abstractmethod
    def emergency_cleanup(self, session_id): ...


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


class FakeOpener:
    def __init__(self, answers):
        self.answers = answers
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append((request.get_method(), request.full_url, request.headers,
                              json.loads(request.data) if request.data else None))
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return Response(json.dumps(answer).encode())


class NoForwarder:
    def ensure(self):
        pass


def gateway_session(**values):
    module = types.ModuleType("gateway.session_context")
    module.get_session_env = lambda name: values.get(name.removeprefix("HERMES_SESSION_").lower(), "")
    return patch.dict(sys.modules, {"gateway": types.ModuleType("gateway"), "gateway.session_context": module})


def provider(answers, **env):
    with patch.dict(os.environ, {"GROK_BOX_BROWSER_TOKEN": "secret", **env}, clear=False):
        config = plugin.Config()
    opener = FakeOpener(answers)
    broker = plugin.Broker(config, NoForwarder(), opener=opener)
    return plugin.make_provider_class(BrowserProvider)(broker), opener


class PolicyTests(unittest.TestCase):
    def test_each_linear_issue_gets_its_own_browser(self):
        self.assertEqual(call(plugin.__file__, "taskKey", "slack", "leon-532-have-a-grok-bot-run", "C0CM6BH8EP8", "s1"),
                         "leon-532")
        self.assertEqual(call(plugin.__file__, "taskKey", "slack", "LEON-7", "C1", "s1"), "leon-7")
        # Outside issue channels: one browser per conversation, then per Hermes task.
        self.assertEqual(call(plugin.__file__, "taskKey", "slack", "feed-gmail", "C0CK9T3L9E2", "s1"),
                         "slack-c0ck9t3l9e2")
        self.assertEqual(call(plugin.__file__, "taskKey", "", "", "", "20261126_144119_91cb4dfb"),
                         "hermes-20261126-144119-91cb4dfb")
        self.assertEqual(call(plugin.__file__, "taskKey", "", "", "", ""), "hermes")
        self.assertEqual(call(plugin.__file__, "issueIdentifier", "leon-532"), "LEON-532")
        self.assertIsNone(call(plugin.__file__, "issueIdentifier", "slack-c1"))
        self.assertTrue(call(plugin.__file__, "shouldRetire", "completed"))
        self.assertTrue(call(plugin.__file__, "shouldRetire", "canceled"))
        self.assertFalse(call(plugin.__file__, "shouldRetire", "started"))


class ProviderTests(unittest.TestCase):
    def test_a_turn_in_an_issue_channel_gets_that_issues_chrome(self):
        browser, opener = provider([{"task": "leon-532", "ws": "/s/abc/devtools/browser/x", "seeded": 2433}],
                                   GROK_BOX_BROWSER_LOCAL_PORT="19400")
        self.assertEqual(browser.name, "grok-box")
        self.assertTrue(browser.is_available())
        with gateway_session(platform="slack", chat_name="leon-532-check-my-bell-plan", chat_id="C0CM6BH8EP8"):
            info = browser.create_session("20261126_144119_91cb4dfb")
        self.assertEqual(info["cdp_url"], "ws://127.0.0.1:19400/s/abc/devtools/browser/x")
        self.assertEqual(info["bb_session_id"], "leon-532")
        self.assertEqual(info["features"]["seeded_cookies"], 2433)
        method, url, headers, body = opener.requests[0]
        self.assertEqual((method, url, body), ("POST", "http://127.0.0.1:19400/v1/sessions", {"task": "leon-532"}))
        self.assertEqual(headers["Authorization"], "Bearer secret")

        # Hermes closing its session only releases it: the box keeps the Chrome and its profile.
        opener.answers.append({"released": True})
        self.assertTrue(browser.close_session("leon-532"))
        self.assertEqual(opener.requests[-1][1], "http://127.0.0.1:19400/v1/sessions/leon-532/release")

    def test_an_unreachable_box_tells_hermes_how_to_bring_it_back(self):
        browser, _ = provider([urllib.error.URLError("connection refused")])
        with gateway_session(platform="slack", chat_name="leon-1-x", chat_id="C1"):
            with self.assertRaises(RuntimeError) as raised:
                browser.create_session("t")
        self.assertIn("bash /workspace/hermes-browsers/box/up.sh", str(raised.exception))
        busy = urllib.error.HTTPError("http://x", 503, "busy", {}, io.BytesIO(b'{"error": "all 6 browsers are busy"}'))
        browser, _ = provider([busy])
        with gateway_session(platform="slack", chat_name="leon-1-x", chat_id="C1"):
            with self.assertRaises(RuntimeError) as raised:
                browser.create_session("t")
        self.assertIn("503: all 6 browsers are busy", str(raised.exception))
        with patch.dict(os.environ, {"GROK_BOX_BROWSER_TOKEN": ""}):
            config = plugin.Config()
        unconfigured = plugin.make_provider_class(BrowserProvider)(plugin.Broker(config, NoForwarder()))
        self.assertFalse(unconfigured.is_available())
        self.assertFalse(unconfigured.close_session("leon-1"))

    def test_finished_issues_are_retired(self):
        sessions = {"sessions": [{"task": "leon-1"}, {"task": "leon-2"}, {"task": "leon-3", "retiredAt": 1},
                                 {"task": "slack-c1"}]}
        browser, opener = provider([sessions, {"retired": True}], LINEAR_API_KEY="lin")
        states = {"LEON-1": "completed", "LEON-2": "started"}
        retired = plugin.retire_finished(browser.broker, state=lambda identifier, key: states[identifier])
        self.assertEqual(retired, ["leon-1"])
        self.assertEqual(opener.requests[-1][1], "http://127.0.0.1:19400/v1/sessions/leon-1/retire")

    def test_register_adds_the_provider(self):
        registered = []
        ctx = types.SimpleNamespace(register_browser_provider=registered.append)
        stub = types.ModuleType("agent.browser_provider")
        stub.BrowserProvider = BrowserProvider
        with patch.dict(sys.modules, {"agent": types.ModuleType("agent"), "agent.browser_provider": stub}), \
                patch.dict(os.environ, {"GROK_BOX_BROWSER_TOKEN": "", "LINEAR_API_KEY": ""}):
            plugin.register(ctx)
        self.assertEqual([entry.name for entry in registered], ["grok-box"])


class ForwarderTests(unittest.TestCase):
    def test_connections_are_carried_by_the_dial_command(self):
        echo = socket.socket()
        echo.bind(("127.0.0.1", 0))
        echo.listen()

        def serve():
            connection, _ = echo.accept()
            with connection:
                while data := connection.recv(1024):
                    connection.sendall(data.upper())

        threading.Thread(target=serve, daemon=True).start()
        relay = ("import socket,sys,threading,os\n"
                 "s=socket.create_connection((sys.argv[1],int(sys.argv[2])))\n"
                 "def up():\n"
                 "    while d:=os.read(0,65536): s.sendall(d)\n"
                 "    s.shutdown(socket.SHUT_WR)\n"
                 "threading.Thread(target=up,daemon=True).start()\n"
                 "while d:=s.recv(65536): os.write(1,d)\n")
        port = echo.getsockname()[1]
        free = socket.socket()
        free.bind(("127.0.0.1", 0))
        local = free.getsockname()[1]
        free.close()
        forwarder = plugin.Forwarder(local, lambda: [sys.executable, "-c", relay, "127.0.0.1", str(port)])
        forwarder.ensure()
        forwarder.ensure()
        try:
            client = socket.create_connection(("127.0.0.1", local), timeout=10)
            client.sendall(b"cdp")
            self.assertEqual(client.recv(1024), b"CDP")
            client.close()
            # A second copy of the plugin (before a reload's restart) leaves the port to the first.
            other = plugin.Forwarder(local, lambda: [])
            other.ensure()
            self.assertTrue(other.shared)
        finally:
            forwarder.close()
            echo.close()


if __name__ == "__main__":
    unittest.main()
