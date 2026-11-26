"""The bridge every Hermes plugin uses to run its policy.cjs.

Run with the plugins' tests (see DEVELOPMENT.md):
    uv run --no-project --python 3.14 --with pythonmonkey==1.5.1 --with pytest python -m pytest \
        --rootdir=. --import-mode=importlib packages/ai/leonsilicon/configs/hermes-mirrors/__tests__
"""
import asyncio
import importlib.util
import itertools
import logging
import math
import os
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

RUNTIME = Path(__file__).resolve().parents[1] / "_pythonmonkey.py"
_names = itertools.count()

POLICY = r"""
let counter = 0;
exports.version = () => "one";
exports.echo = (value) => value;
exports.count = () => ++counter;
exports.describe = (value) => ({ type: typeof value, array: Array.isArray(value) });
exports.fallback = (value = "fallback", { name = "unnamed" } = {}) => [value, name];
exports.keys = (value) => [Object.keys(value), "gone" in value, value.gone === undefined, value.list];
exports.none = (host) => [host.nothing() === undefined, typeof host.row().missing];
exports.shapes = () => ({
  missing: undefined, nothing: null, hole: [1, , 3], inf: Infinity, ninf: -Infinity, nan: NaN,
  int: 3, float: 1.5, text: "a\u{1F600}b", lone: "a\ud83d", when: new Date(0), fn: () => 1,
});
exports.fail = () => { throw new TypeError("js failure"); };
exports.later = async (value) => { await null; return value; };
exports.mutate = (value) => { value.changed = true; value.rows.push(4); return value; };
exports.read_rows = (rows) => rows.reduce((total, row) => total + row.id.length + row.text.length, 0);
exports.cut = (text, end) => text.slice(0, end);
exports.steps = async (host) => { await host.step(1); await host.step(2); await host.step(3); return "done"; };
exports.spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end); return true; };
exports.double = (host, value) => host.double(value) + 1;
exports.slow = async (host, value) => (await host.slow(value)) + 1;
exports.arity = (host) => [host.one(), host.one(1, 2, 3), host.two(1), host.any(1, 2, 3), host.none(7)];
exports.keep = (host) => { globalThis.keptByTest = host.double; return true; };
exports.late = () => globalThis.keptByTest(2);
exports.again = (host) => host.again();
exports.caught = (host) => { try { host.boom(); } catch (error) { return String(error.message).split("\n")[0]; } };
exports.caughtLater = async (host) => {
  try { await host.boom(); } catch (error) { return String(error.message).split("\n")[0]; }
};
exports.workflow = async (host, value) => {
  const seen = await host.read(value);
  await host.write(seen.text + "!", host.size(seen.text));
  return { seen, done: true };
};
exports.failing = async (host) => { await host.read("x"); };
"""


def load_runtime():
    """A fresh copy of the bridge, as each plugin has its own."""
    spec = importlib.util.spec_from_file_location(f"hermes_pythonmonkey_test_{next(_names)}", RUNTIME)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def bridge():
    return load_runtime()


@pytest.fixture
def plugin(tmp_path):
    (tmp_path / "policy.cjs").write_text(POLICY)
    return str(tmp_path / "__init__.py")


def on_engine(bridge, function):
    """Run `function(engine)` on the engine's thread."""
    loop, engine = bridge._engine()

    async def run():
        return function(engine)

    return asyncio.run_coroutine_threadsafe(run(), loop).result(60)


def test_values_round_trip(bridge, plugin):
    value = {
        "none": None, "yes": True, "no": False, "int": 7, "float": 1.25, "big": 2 ** 53 - 1,
        "text": "plain", "accent": "café", "emoji": "a\U0001F600b", "empty": "",
        "list": [1, [2, [3]], {"deep": {"er": []}}], "tuple": (1, "two"), "inf": math.inf, "ninf": -math.inf,
        "quote": 'he said "hi"\n\ttab \\ back', "nul": "a\x00b", "key with $": 1,
    }
    result = bridge.call(plugin, "echo", value)
    assert math.isnan(bridge.call(plugin, "echo", math.nan))
    assert result == {**value, "tuple": [1, "two"]}
    # A value JavaScript only passes on comes back as it was.
    assert type(result["int"]) is int and type(result["float"]) is float and type(result["text"]) is str
    huge = {"id": 2 ** 64 + 1, "negative": -(2 ** 60)}
    assert bridge.call(plugin, "echo", huge) == huge


def test_javascript_values_arrive_as_plain_python(bridge, plugin):
    shapes = bridge.call(plugin, "shapes")
    assert shapes["missing"] is None and "missing" in shapes
    assert shapes["nothing"] is None
    assert shapes["hole"] == [1, None, 3]
    assert shapes["inf"] == math.inf and shapes["ninf"] == -math.inf and math.isnan(shapes["nan"])
    # Half a surrogate pair is text Python cannot encode; it arrives as the replacement character.
    assert shapes["text"] == "a\U0001F600b" and shapes["lone"] == "a\ufffd"
    assert bridge.call(plugin, "cut", "ab\U0001F600", 3).encode() == "ab\ufffd".encode()
    assert shapes["when"] == "1970-01-01T00:00:00.000Z"
    assert "fn" not in shapes
    assert bridge.call(plugin, "describe", [1]) == {"type": "object", "array": True}
    assert bridge.call(plugin, "echo") is None


def test_none_is_undefined_in_javascript(bridge, plugin):
    """PythonMonkey's own mapping, which the policies are written for: a default parameter and a
    destructuring default apply to undefined, not to null."""
    assert bridge.call(plugin, "describe", None)["type"] == "undefined"
    assert bridge.call(plugin, "fallback", None, {"name": None}) == ["fallback", "unnamed"]
    # The key and the list slot stay where they were.
    assert bridge.call(plugin, "keys", {"gone": None, "list": [None, 1]}) == [["gone", "list"], True, True, [None, 1]]
    assert bridge.call(plugin, "none", {"nothing": lambda: None, "row": lambda: {"missing": None}}) == [True, "undefined"]


def test_javascript_gets_a_snapshot(bridge, plugin):
    value = {"rows": [1, 2, 3]}
    assert bridge.call(plugin, "mutate", value) == {"rows": [1, 2, 3, 4], "changed": True}
    assert value == {"rows": [1, 2, 3]}


def test_values_json_cannot_carry(bridge, plugin, caplog):
    with caplog.at_level(logging.WARNING):
        assert bridge.call(plugin, "echo", {"keep": 1, "odd": {1, 2}, "raw": b"bytes"}) == {"keep": 1, "odd": {}, "raw": {}}
        assert bridge.call(plugin, "describe", object())["type"] == "object"
    assert "set cannot cross into JavaScript" in caplog.text
    with pytest.raises(Exception, match="exports no function named nothing"):
        bridge.call(plugin, "nothing")


def test_a_module_is_loaded_once(bridge, plugin):
    assert [bridge.call(plugin, "count") for _ in range(3)] == [1, 2, 3]


def test_a_reloaded_plugin_gets_the_new_file_and_the_old_one_keeps_its_own(bridge, plugin):
    assert bridge.call(plugin, "version") == "one"
    assert bridge.call(plugin, "count") == 1
    Path(plugin).with_name("policy.cjs").write_text(POLICY.replace('"one"', '"two"'))
    reloaded = load_runtime()
    assert reloaded.call(plugin, "version") == "two"
    assert reloaded.call(plugin, "count") == 1
    # The old Python still has the JavaScript it was written for.
    assert bridge.call(plugin, "version") == "one"
    assert bridge.call(plugin, "count") == 2


def test_a_failed_load_is_not_kept(bridge, tmp_path):
    plugin = str(tmp_path / "__init__.py")
    with pytest.raises(Exception):
        bridge.call(plugin, "version")
    (tmp_path / "policy.cjs").write_text(POLICY)
    assert bridge.call(plugin, "version") == "one"


def test_python_strings_are_copied_into_javascript(bridge, plugin):
    """The cause of the 2026-11-26 freeze: PythonMonkey shares a str it is given, then scans every
    shared str for each one JavaScript's collector frees. A shared str gains a reference."""
    bridge.call(plugin, "echo", 1)
    assert on_engine(bridge, bridge._copies) is True
    text = "a text made at run time %d" % time.time_ns()
    row = {"text": text, text: 1}
    before = sys.getrefcount(text)
    assert bridge.call(plugin, "echo", row) == {"text": text, text: 1}
    assert sys.getrefcount(text) == before


def test_collecting_stays_cheap_after_many_strings(bridge, plugin):
    """600 calls like these froze the old bridge for minutes: 150,000 strings, each scanned for."""
    started = time.monotonic()
    for round_ in range(600):
        rows = [{"id": f"m{round_}-{row}", "text": f"message {row} of round {round_} " + "lorem ipsum " * 8}
                for row in range(125)]
        assert bridge.call(plugin, "read_rows", rows) > 0
    began = time.monotonic()
    on_engine(bridge, lambda engine: engine.collect())
    assert time.monotonic() - began < 2
    assert time.monotonic() - started < 60


def test_collections_are_scheduled_only_on_an_engine_this_bridge_started(bridge, plugin, monkeypatch):
    """During a deploy the new bridge shares the engine an old copy started. That engine holds the
    old copy's shared strings, and a collection is what frees them, at the cost that froze Hermes."""
    _, engine = bridge._engine()
    collections = []
    collect = engine.collect
    monkeypatch.setattr(engine, "collect", lambda: collections.append(1) or collect())
    monkeypatch.setattr(bridge._runtime, "collects", False)
    for _ in range(bridge.COLLECT_EVERY * 2):
        bridge.call(plugin, "echo", 1)
    assert collections == []
    monkeypatch.setattr(bridge._runtime, "collects", True)
    for _ in range(bridge.COLLECT_EVERY * 2):
        bridge.call(plugin, "echo", 1)
    assert len(collections) == 2


def test_python_callbacks(bridge, plugin):
    host = {"double": lambda value: value * 2}
    assert bridge.call(plugin, "double", host, 4) == 9

    def slow(value):
        time.sleep(0.01)
        return value * 3

    # A sync call of an asynchronous function is fine off the engine's thread.
    assert bridge.call(plugin, "slow", {"slow": bridge.blocking(slow)}, 2) == 7
    assert bridge.call(plugin, "later", {"a": 1}) == {"a": 1}


def test_callbacks_get_javascript_calling_convention(bridge, plugin):
    class Host:
        def two(self, first, second):
            return [first, second]

    host = {
        "one": lambda value: value, "two": Host().two, "any": lambda *values: list(values),
        "none": lambda: "nothing",
    }
    assert bridge.call(plugin, "arity", host) == [None, 1, [1, None], [1, 2, 3], "nothing"]
    # A callable with no real code object gets what JavaScript passed.
    from unittest.mock import AsyncMock, Mock
    assert bridge.call(plugin, "double", {"double": Mock(return_value=3)}, 4) == 4
    assert bridge.call(plugin, "slow", {"slow": AsyncMock(return_value=5)}, 2) == 6
    assert bridge.call(plugin, "double", {"double": abs}, -4) == 5


def test_callback_errors_reach_javascript(bridge, plugin):
    def boom():
        raise ValueError("bad thing")

    async def boom_later():
        raise ValueError("bad thing later")

    assert bridge.call(plugin, "caught", {"boom": boom}) == "Python ValueError: bad thing"
    assert bridge.call(plugin, "caughtLater", {"boom": boom_later}) == "Python ValueError: bad thing later"


def test_a_callback_cannot_outlive_its_call(bridge, plugin):
    assert bridge.call(plugin, "keep", {"double": lambda value: value * 2}) is True
    with pytest.raises(Exception, match="after its policy call had finished"):
        bridge.call(plugin, "late")
    assert bridge._shared().hosts == {}


def test_a_call_from_a_callback_does_not_wait_for_itself(bridge, plugin):
    """call() on the engine's thread used to wait for the engine's loop, which was waiting for it."""
    results = []

    def run():
        results.append(bridge.call(plugin, "again", {"again": lambda: bridge.call(plugin, "echo", "inner")}))
        try:
            bridge.call(plugin, "again", {"again": lambda: bridge.call(plugin, "later", 1)})
        except Exception as error:
            results.append(str(error))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(30)
    assert not worker.is_alive()
    assert results[0] == "inner"
    assert "Use acall()" in results[1]


def test_holding_an_event_loop_for_an_asynchronous_function_is_logged(bridge, plugin, caplog):
    async def main():
        with caplog.at_level(logging.WARNING):
            assert bridge.call(plugin, "echo", "a plain function is fine") == "a plain function is fine"
            assert "Use acall()" not in caplog.text
            assert bridge.call(plugin, "later", 1) == 1
        assert "holds the event loop" in caplog.text and "later" in caplog.text
        assert await bridge.acall(plugin, "later", 1) == 1

    asyncio.run(main())


def test_errors_cross_without_the_engine(bridge, plugin):
    with pytest.raises(Exception) as caught:
        bridge.call(plugin, "fail")
    error = caught.value
    assert type(error).__name__ == "SpiderMonkeyError"
    assert "js failure" in str(error)
    # The thrown JavaScript value and the engine's frames stay on the engine's thread.
    assert error.jsError is None
    frames = []
    traceback = error.__traceback__
    while traceback:
        frames.append(traceback.tb_frame.f_code.co_name)
        traceback = traceback.tb_next
    assert frames == ["test_errors_cross_without_the_engine", "call"]


def test_workflows_run_callbacks_on_the_host_loop(bridge, plugin):
    async def main():
        host_thread = threading.get_ident()
        written = []

        async def read(value):
            assert threading.get_ident() == host_thread
            await asyncio.sleep(0)
            return {"text": value, "n": 1}

        def write(text, size):
            assert threading.get_ident() == host_thread
            written.append((text, size))

        def size(text):
            assert threading.get_ident() != host_thread
            return len(text)

        result = await bridge.acall_with_host(
            plugin, "workflow", {"read": read, "write": write}, "abc", immediate={"size": size},
        )
        assert result == {"seen": {"text": "abc", "n": 1}, "done": True}
        assert written == [("abc!", 3)]

        class Refused(Exception):
            pass

        async def refuse(_):
            raise Refused("no")

        with pytest.raises(Refused):
            await bridge.acall_with_host(plugin, "failing", {"read": refuse})
        assert await bridge.acall(plugin, "later", [1, 2]) == [1, 2]

    asyncio.run(main())


def test_a_cancelled_workflow_stops_at_its_next_callback(bridge, plugin):
    async def main():
        steps = []
        release = asyncio.Event()

        async def step(number):
            steps.append(number)
            await release.wait()

        task = asyncio.ensure_future(bridge.acall_with_host(plugin, "steps", {"step": step}))
        while not steps:
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        release.set()
        await asyncio.sleep(0.3)
        assert steps == [1]
        assert await bridge.acall(plugin, "echo", "still working") == "still working"

    asyncio.run(main())
    assert bridge._shared().hosts == {}


def test_many_threads_call_at_once(bridge, plugin):
    failures = []

    def work(thread):
        for round_ in range(150):
            value = {"thread": thread, "round": round_, "text": f"t{thread} r{round_} \U0001F600"}
            if bridge.call(plugin, "echo", value) != value:
                failures.append(value)

    workers = [threading.Thread(target=work, args=(thread,)) for thread in range(8)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(60)
    assert not failures and not any(worker.is_alive() for worker in workers)


def run_script(source, home, seconds="120", timeout=60):
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_PYTHONMONKEY_DEADMAN_SECONDS": seconds}
    return subprocess.run(
        [sys.executable, "-c", PREAMBLE + textwrap.dedent(source), str(RUNTIME), str(home / "plugin" / "__init__.py")],
        env=env, capture_output=True, text=True, timeout=timeout,
    )


PREAMBLE = """
import importlib.util, logging, sys
logging.basicConfig(level=logging.INFO, stream=sys.stdout)
spec = importlib.util.spec_from_file_location("bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
plugin = sys.argv[2]
"""


def test_a_stuck_engine_ends_the_process(tmp_path):
    """JavaScript that never returns holds the interpreter lock, so no Python watchdog can act.
    The process has to end by itself, with the stacks on file, for the supervisor to restart it."""
    (tmp_path / "plugin").mkdir()
    (tmp_path / "plugin" / "policy.cjs").write_text(POLICY)
    began = time.monotonic()
    stuck = run_script("""
        print(bridge.call(plugin, "echo", "started"), flush=True)
        bridge.call(plugin, "spin", 45000)
        print("the engine came back", flush=True)
    """, tmp_path, seconds="2")
    assert stuck.returncode == 1
    assert "started" in stuck.stdout and "the engine came back" not in stuck.stdout
    assert time.monotonic() - began < 30
    dump = (tmp_path / "logs" / "pythonmonkey-deadman.log").read_text()
    # Linux shows the first 15 characters of a thread's name.
    assert "Timeout" in dump and "hermes-pythonmo" in dump and "_pythonmonkey.py" in dump

    # The next process says what happened, once.
    after = run_script('print(bridge.call(plugin, "echo", "fine"))', tmp_path)
    assert after.returncode == 0 and "fine" in after.stdout
    assert "The PythonMonkey watchdog ended a Hermes process" in after.stdout
    again = run_script('print(bridge.call(plugin, "echo", "fine"))', tmp_path)
    assert again.returncode == 0 and "watchdog ended" not in again.stdout


def test_a_healthy_engine_is_left_alone(tmp_path):
    (tmp_path / "plugin").mkdir()
    (tmp_path / "plugin" / "policy.cjs").write_text(POLICY)
    healthy = run_script("""
        import time
        for _ in range(8):
            bridge.call(plugin, "spin", 300)
            time.sleep(0.2)
        print("still here", flush=True)
    """, tmp_path, seconds="3")
    assert healthy.returncode == 0 and "still here" in healthy.stdout
    assert (tmp_path / "logs" / "pythonmonkey-deadman.log").read_text() == ""


def test_memory_stays_flat(tmp_path):
    """The old bridge evaluated policy.cjs again on every call and grew by about 80 KB each time."""
    (tmp_path / "plugin").mkdir()
    (tmp_path / "plugin" / "policy.cjs").write_text(POLICY)
    result = run_script("""
        import resource
        scale = 1 if sys.platform == "darwin" else 1024
        used = lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * scale / 2 ** 20
        rows = [{"id": str(row), "text": "lorem ipsum " * 20} for row in range(20)]
        for _ in range(1000):
            bridge.call(plugin, "echo", rows)
        warm = used()
        for _ in range(5000):
            bridge.call(plugin, "echo", rows)
        print("grew", used() - warm, flush=True)
    """, tmp_path, timeout=180)
    assert result.returncode == 0, result.stderr
    assert float(result.stdout.split("grew")[1]) < 48
