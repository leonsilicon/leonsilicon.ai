import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { patchClaudeAdapter } from "#codemod";

const before = readFileSync(new URL("../@fixtures/before.js", import.meta.url), "utf8");
const after = readFileSync(new URL("../@fixtures/after.js", import.meta.url), "utf8");

test("the codemod produces the reviewed fixture and is idempotent", () => {
  assert.equal(patchClaudeAdapter(before), after);
  assert.equal(patchClaudeAdapter(after), null);
});

test("missing or duplicate anchors are rejected rather than partially patched", () => {
  assert.throws(
    () => patchClaudeAdapter(before.replace("429", "430")),
    /Unsupported Claude adapter/,
  );
  assert.throws(() => patchClaudeAdapter(`${before}\n${before}`), /Unsupported Claude adapter/);
});

test("a partial patch can be completed without duplicating its busy detector", () => {
  const partial = before.replace(
    "    /Retrying in\\b/i,",
    "    /Retrying in\\b/i,\n    /Waiting for API response\\b/i,",
  );
  assert.equal(patchClaudeAdapter(partial), after);
});
