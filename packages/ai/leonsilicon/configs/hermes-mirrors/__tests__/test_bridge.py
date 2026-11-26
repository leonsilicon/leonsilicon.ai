"""The bridge every Hermes plugin uses to run its policy.cjs.

Build the worker first (`vpr -w build:hermes-plugins`), then run with the plugins' tests:
    uv run --no-project --python 3.14 --with pygls==2.1.1 --with pytest python -m pytest \
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

RUNTIME = Path(__file__).resolve().parents[1] / "_bridge.py"
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
exports.busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end); return true; };
exports.adrift = () => { Promise.reject(new Error("nobody is listening")); return "returned"; };
exports.pid = () => process.pid;
"""


def load_runtime():
    """A fresh copy of the bridge, as each plugin has its own."""
    spec = importlib.util.spec_from_file_location(f"hermes_bridge_test_{next(_names)}", RUNTIME)
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
    """The mapping the policies are written for, from their time on PythonMonkey: a default
    parameter and a destructuring default apply to undefined, not to null."""
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


def test_no_javascript_runs_inside_python(bridge, plugin):
    """What froze Hermes for four hours on 2026-11-26: JavaScript inside the process holds Python's
    interpreter lock for as long as it or its collector runs. It runs in a process of its own now."""
    assert bridge.call(plugin, "pid") != os.getpid()
    assert "pythonmonkey" not in sys.modules
    ticks = []

    def tick():
        while len(ticks) < 1000:
            ticks.append(1)
            time.sleep(0.02)

    threading.Thread(target=tick, daemon=True).start()
    time.sleep(0.1)
    before = len(ticks)
    assert bridge.call(plugin, "busy", 1000) is True
    # Another Python thread ran all the while. Under PythonMonkey it ran once in six seconds.
    assert len(ticks) - before > 25


def test_many_strings_cost_what_they_weigh(bridge, plugin):
    """600 calls like these froze the old bridge for minutes: PythonMonkey scanned every string it
    had been given for each one JavaScript's collector freed."""
    started = time.monotonic()
    for round_ in range(600):
        rows = [{"id": f"m{round_}-{row}", "text": f"message {row} of round {round_} " + "lorem ipsum " * 8}
                for row in range(125)]
        assert bridge.call(plugin, "read_rows", rows) > 0
    assert time.monotonic() - started < 30


def test_large_values_cross_both_ways(bridge, plugin):
    text = "a line of text with \u00e9 and \U0001F600\n" * 60_000
    assert bridge.call(plugin, "echo", {"text": text}) == {"text": text}
    assert bridge.call(plugin, "double", {"double": lambda value: value + value}, text) == text + text + "1"


def test_a_promise_nobody_awaits_does_not_end_the_worker(bridge, plugin):
    worker = bridge.call(plugin, "pid")
    assert bridge.call(plugin, "adrift") == "returned"
    time.sleep(0.3)
    assert bridge.call(plugin, "pid") == worker


def test_python_callbacks(bridge, plugin):
    host = {"double": lambda value: value * 2}
    assert bridge.call(plugin, "double", host, 4) == 9

    def slow(value):
        time.sleep(0.01)
        return value * 3

    # A sync call of an asynchronous function is fine off the engine's thread.
    assert bridge.call(plugin, "slow", {"slow": bridge.blocking(slow)}, 2) == 7
    assert bridge.call(plugin, "later", {"a": 1}) == {"a": 1}
    # A plain function answers at once, even when what it hands back has to be awaited.
    assert bridge.call(plugin, "double", {"double": lambda value: asyncio.sleep(0.01, value * 2)}, 4) == 9


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
    assert bridge._bridge().hosts == {}


def test_a_call_from_a_callback_does_not_wait_for_itself(bridge, plugin):
    """JavaScript's one thread is waiting for the Python function, so it runs the policy that
    function calls there and then, and goes on waiting."""
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
    # Callbacks of the inner call work too, and the outer one still gets its answer.
    inner = lambda: bridge.call(plugin, "double", {"double": lambda value: value * 2}, 5)
    assert bridge.call(plugin, "again", {"again": inner}) == 11


def test_holding_an_event_loop_for_an_asynchronous_function_is_logged(bridge, plugin, caplog):
    async def main():
        with caplog.at_level(logging.WARNING):
            assert bridge.call(plugin, "echo", "a plain function is fine") == "a plain function is fine"
            assert "Use acall()" not in caplog.text
            assert bridge.call(plugin, "later", 1) == 1
        assert "held the event loop" in caplog.text and "later" in caplog.text
        assert await bridge.acall(plugin, "later", 1) == 1

    asyncio.run(main())


def test_a_policy_error_reaches_python(bridge, plugin):
    with pytest.raises(Exception) as caught:
        bridge.call(plugin, "fail")
    error = caught.value
    assert type(error).__name__ == "PolicyError" and isinstance(error, RuntimeError)
    # JavaScript's own message and stack.
    assert str(error).startswith("TypeError: js failure\n") and "policy.cjs" in str(error)


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
            # A plain function answers on the bridge's own thread, never on the host's loop.
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
    assert bridge._bridge().hosts == {}


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


def run_script(source, home, stall="15", timeout=90):
    env = {**os.environ, "HERMES_HOME": str(home), "HERMES_POLICY_STALL_SECONDS": stall}
    return subprocess.run(
        [sys.executable, "-c", PREAMBLE + textwrap.dedent(source), str(RUNTIME), str(home / "plugin" / "__init__.py")],
        env=env, capture_output=True, text=True, timeout=timeout,
    )


PREAMBLE = """
import importlib.util, logging, os, subprocess, sys, threading, time
logging.basicConfig(level=logging.INFO, stream=sys.stdout)
spec = importlib.util.spec_from_file_location("bridge", sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
plugin = sys.argv[2]
"""


@pytest.fixture
def home(tmp_path):
    (tmp_path / "plugin").mkdir()
    (tmp_path / "plugin" / "policy.cjs").write_text(POLICY)
    return tmp_path


def test_a_stuck_worker_is_replaced_and_python_never_stops(home):
    """A policy that never returns used to stop all of Hermes. Now its worker is ended, its call
    fails, and the next call has a new worker."""
    result = run_script("""
        ticks = []
        def tick():
            while True:
                ticks.append(1); time.sleep(0.05)
        threading.Thread(target=tick, daemon=True).start()
        first = bridge.call(plugin, "pid")
        began = time.monotonic()
        try:
            bridge.call(plugin, "spin", 600000)
            print("the policy returned")
        except bridge.WorkerError as error:
            print("failed:", error)
        took = time.monotonic() - began
        print("took under 20 s:", took < 20, "| python kept running:", len(ticks) > took / 0.05 * 0.6)
        print("a new worker answers:", bridge.call(plugin, "echo", "fine"), bridge.call(plugin, "pid") != first)
    """, home, stall="2")
    assert result.returncode == 0, result.stderr
    assert "failed: The policy worker was ended: its JavaScript did not answer for 2 seconds." in result.stdout
    assert "took under 20 s: True | python kept running: True" in result.stdout
    assert "a new worker answers: fine True" in result.stdout
    assert "the policy returned" not in result.stdout


def test_a_call_with_no_side_effects_is_sent_again_when_its_worker_ends(home):
    result = run_script("""
        import signal
        worker = bridge.call(plugin, "pid")
        threading.Timer(0.3, os.kill, (worker, signal.SIGKILL)).start()
        print("answered:", bridge.call(plugin, "busy", 1000), bridge.call(plugin, "pid") != worker)
        # A call that used a Python callback may have done something already, so it fails instead.
        worker = bridge.call(plugin, "pid")
        def slow(value):
            os.kill(worker, signal.SIGKILL)   # the worker ends while its call waits for this
            time.sleep(0.5)
            return value
        try:
            bridge.call(plugin, "slow", {"slow": bridge.blocking(slow)}, 1)
            print("the workflow returned")
        except bridge.WorkerError as error:
            print("failed:", error)
    """, home)
    assert result.returncode == 0, result.stderr
    assert "answered: True True" in result.stdout
    assert "failed: The policy worker" in result.stdout and "-9" in result.stdout
    assert "pygls" not in result.stdout


def test_a_working_worker_is_left_alone(home):
    result = run_script("""
        worker = bridge.call(plugin, "pid")
        for _ in range(8):
            bridge.call(plugin, "busy", 400)
            time.sleep(0.2)
        # JavaScript waiting for a slow Python function is not JavaScript that has stopped.
        assert bridge.call(plugin, "double", {"double": lambda value: time.sleep(6) or value * 2}, 4) == 9
        print("same worker:", bridge.call(plugin, "pid") == worker)
    """, home, stall="4")
    assert result.returncode == 0, result.stderr
    assert "same worker: True" in result.stdout and "was ended" not in result.stdout


def test_a_worker_does_not_outlive_python(home):
    """Even one whose JavaScript is spinning and cannot see that its pipes have closed."""
    result = run_script("""
        print("idle", bridge.call(plugin, "pid"), flush=True)
        os._exit(0)
    """, home)
    spinning = run_script("""
        print("spinning", bridge.call(plugin, "pid"), flush=True)
        threading.Thread(target=lambda: bridge.call(plugin, "spin", 600000), daemon=True).start()
        time.sleep(0.5)
        os._exit(0)
    """, home)
    workers = [int(run.stdout.split()[1]) for run in (result, spinning)]
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        alive = [worker for worker in workers if subprocess.run(["kill", "-0", str(worker)], capture_output=True).returncode == 0]
        if not alive:
            break
        time.sleep(0.3)
    assert alive == []


def test_memory_stays_flat(home):
    result = run_script("""
        used = lambda pid: int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(pid)]).strip()) / 1024
        rows = [{"id": str(row), "text": "lorem ipsum " * 20} for row in range(20)]
        worker = bridge.call(plugin, "pid")
        for _ in range(3000):
            bridge.call(plugin, "echo", rows)
        warm = used(os.getpid()), used(worker)
        for _ in range(12000):
            bridge.call(plugin, "echo", rows)
        print("grew", used(os.getpid()) - warm[0], used(worker) - warm[1], flush=True)
    """, home, timeout=240)
    assert result.returncode == 0, result.stderr
    python, worker = (float(number) for number in result.stdout.split("grew")[1].split())
    assert python < 24 and worker < 48
