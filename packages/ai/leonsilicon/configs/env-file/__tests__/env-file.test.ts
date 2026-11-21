import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEnv } from "node:util";
import { formatEnvFile } from "#env-file";

test("Node reads back exactly what was written", () => {
  const values = {
    TOKEN: "a1b2c3",
    PORT: 18787,
    ROOTS: "/Volumes/Work/Developer:/Users/someone/Developer",
    URL: "https://example.com/a?b=c#d",
    SINGLE: "it's",
    BOTH: `it's "quoted"`,
    BACKSLASH: "C:\\path\\n",
    SPACES: "  padded  ",
    EMPTY: "",
  };
  const parsed = { ...parseEnv(formatEnvFile(values, "header\nsecond line")) };
  assert.deepEqual(
    parsed,
    Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])),
  );
});

test("leaves out undefined values and adds the header as comments", () => {
  const text = formatEnvFile({ A: "1", B: undefined, C: null }, "made here");
  assert.equal(text, "# made here\nA='1'\n");
  assert.equal(formatEnvFile({}), "");
});

test("refuses what Node would read back differently", () => {
  assert.throws(() => formatEnvFile({ A: "two\nlines" }), /more than one line/);
  assert.throws(() => formatEnvFile({ A: "'`\"" }), /can't be quoted/);
  assert.throws(() => formatEnvFile({ A: "'`\\" }), /can't be quoted/);
  assert.throws(() => formatEnvFile({ "BAD-KEY": "x" }), /Not an env var name/);
});
