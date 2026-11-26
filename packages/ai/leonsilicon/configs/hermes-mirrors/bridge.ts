/**
 * The process that runs every Hermes plugin's `policy.cjs`. `_bridge.py` starts one for each Hermes
 * process and talks JSON-RPC with it over stdin and stdout.
 *
 * Policies ran inside Hermes before, on PythonMonkey, where slow JavaScript held Python's
 * interpreter lock and stopped every thread of Hermes. Here the worst a policy can do is stop this
 * process, and `_bridge.py` replaces one that stops answering.
 */
import { readSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "@-/com.npmjs.vscode-jsonrpc";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Policy = Record<string, (...values: unknown[]) => unknown>;
interface Outcome {
  ok: boolean;
  text?: string;
  /** The policy function gave a Promise, which Python waited for. */
  waited?: boolean;
  name?: string;
  message?: string;
  stack?: string;
}
interface Invoke {
  copy: string;
  path: string;
  call: number;
  text: string;
}

const MARK = "$hermes.policy";
const load = createRequire(__filename);
const policies = new Map<string, Policy>();
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

function encode(value: unknown): string {
  return JSON.stringify([value], (_, item: unknown) => {
    // Python sees undefined as None; keep the key instead of dropping it.
    if (item === undefined) return null;
    if (typeof item === "number" && !Number.isFinite(item))
      return { [MARK]: "number", value: String(item) };
    if (typeof item === "bigint") return { [MARK]: "integer", value: String(item) };
    // Half of a surrogate pair, left by a slice through an emoji, is text Python cannot encode.
    if (typeof item === "string" && !item.isWellFormed()) return item.toWellFormed();
    return item;
  });
}

// None arrives as undefined, as it did on PythonMonkey, and policies rely on it: a default
// parameter or a destructuring default applies to undefined, not to null. The key or the array
// slot stays.
function revive(node: unknown, call: number): unknown {
  if (node === null) return undefined;
  if (typeof node !== "object") return node;
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index++) node[index] = revive(node[index], call);
    return node;
  }
  const item = node as Record<string, unknown>;
  if (item[MARK] === "number") return Number(item.value);
  if (item[MARK] === "integer") return BigInt(item.value as string);
  if (item[MARK] === "function") {
    const index = item.value as number;
    // A plain Python function answers before the next line runs, as it did. A coroutine function
    // gives a Promise.
    return item.sync
      ? (...values: unknown[]) => hostNow(call, index, values)
      : (...values: unknown[]) => hostLater(call, index, values);
  }
  for (const key of Object.keys(item)) item[key] = revive(item[key], call);
  return item;
}

const decode = (text: string, call: number) => revive((JSON.parse(text) as Json[])[0], call);

function answer(outcome: Outcome, call: number): unknown {
  if (outcome.ok) return decode(outcome.text!, call);
  // The message a policy sees for a Python error starts "Python ValueError: …".
  throw new Error(outcome.message);
}

async function hostLater(call: number, index: number, values: unknown[]) {
  const outcome = await connection.sendRequest<Outcome>("host", {
    call,
    index,
    text: encode(values),
  });
  return answer(outcome, call);
}

// The second pair of pipes carries the calls whose answer JavaScript needs at once. Reading it
// blocks this thread, which is the point.
const syncOut = Number(process.env.HERMES_POLICY_SYNC_OUT);
const syncIn = Number(process.env.HERMES_POLICY_SYNC_IN);
const chunk = Buffer.alloc(1 << 16);
let unread = Buffer.alloc(0);

function readLine(): string {
  for (;;) {
    const end = unread.indexOf(10);
    if (end >= 0) {
      const line = unread.toString("utf8", 0, end);
      unread = unread.subarray(end + 1);
      return line;
    }
    const size = readSync(syncIn, chunk);
    if (!size) throw new Error("Hermes closed the policy worker's pipe.");
    unread = Buffer.concat([unread, chunk.subarray(0, size)]);
  }
}

function writeLine(message: unknown) {
  const bytes = Buffer.from(JSON.stringify(message) + "\n");
  for (let sent = 0; sent < bytes.length;) sent += writeSync(syncOut, bytes, sent);
}

function hostNow(call: number, index: number, values: unknown[]) {
  writeLine({ call, index, text: encode(values) });
  for (;;) {
    const message = JSON.parse(readLine()) as { invoke?: Invoke; outcome?: Outcome };
    if (message.outcome) return answer(message.outcome, call);
    // The Python function called a policy before it answered. Run that here: this thread is the
    // only one there is, and it is waiting for that function.
    writeLine({ nested: run(message.invoke!, false) });
  }
}

function policy(copy: string, path: string): Policy {
  // One module for each copy of `_bridge.py`: Hermes imports a plugin again when it reloads it, so
  // the plugin's old Python keeps the JavaScript it started with and its new Python loads the file.
  const key = copy + "\n" + path;
  let loaded = policies.get(key);
  if (!loaded) {
    delete load.cache[load.resolve(path)];
    loaded = load(path) as Policy;
    policies.set(key, loaded);
  }
  return loaded;
}

function failure(error: unknown): Outcome {
  const known = error as { name?: string; message?: string; stack?: string } | undefined;
  return {
    ok: false,
    name: known?.name ?? "Error",
    message: String(known?.message ?? error),
    stack: String(known?.stack ?? ""),
  };
}

function start({ copy, path, call, text }: Invoke): unknown {
  const [name, values] = decode(text, call) as [string, unknown[]];
  const module = policy(copy, path);
  if (typeof module[name] !== "function")
    throw new TypeError("policy.cjs exports no function named " + name);
  return module[name](...values);
}

const thenable = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { then?: unknown }).then === "function";

function run(invoke: Invoke, mayWait: true): Outcome | Promise<Outcome>;
function run(invoke: Invoke, mayWait: false): Outcome;
function run(invoke: Invoke, mayWait: boolean): Outcome | Promise<Outcome> {
  try {
    const result = start(invoke);
    if (!thenable(result)) return { ok: true, text: encode(result) };
    if (!mayWait)
      throw new Error(
        "call() cannot wait for an asynchronous policy function inside a Python function that " +
          "JavaScript is waiting for. Use acall().",
      );
    return Promise.resolve(result).then(
      (value) => ({ ok: true, text: encode(value), waited: true }),
      failure,
    );
  } catch (error) {
    return failure(error);
  }
}

connection.onRequest("invoke", (invoke: Invoke) => run(invoke, true));
connection.onRequest("ping", () => "pong");
connection.onClose(() => process.exit(0));

// A policy that leaves a promise to fail on its own, such as a workflow Python stopped waiting for,
// must not take the other plugins' calls down with it.
process.on("unhandledRejection", (reason) => {
  process.stderr.write("unhandled rejection: " + String((reason as Error)?.stack ?? reason) + "\n");
});
process.on("uncaughtException", (error) => {
  process.stderr.write("uncaught exception: " + String(error?.stack ?? error) + "\n");
});

// When Hermes dies, stdin closes and this process ends, unless a policy is spinning. This thread
// ends it then, so that a spinning worker never outlives its Hermes.
new Worker(
  "const parent = process.ppid;" +
    "setInterval(() => { if (process.ppid !== parent) process.kill(process.pid, 'SIGKILL'); }, 2000);",
  { eval: true },
).unref();

connection.listen();
