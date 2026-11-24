import assert from "node:assert/strict";
import { test } from "node:test";
import { AWAITING_PREFIX, commandLine, commandUsage, matchStatus, parseCommand } from "#command";

const AUTO = "U0AUTOLIN01";

test("a command is a line that starts with Autolinear's mention, the last one counting", () => {
  assert.equal(commandLine(`Done.\n\n<@${AUTO}> move done`, AUTO), "move done");
  assert.equal(commandLine(`<@${AUTO}|autolinear>: stay`, AUTO), "stay");
  assert.equal(commandLine("All set.\n@Autolinear move leon", AUTO), "move leon");
  assert.equal(commandLine("@autolinear move leon", null), "move leon", "plain text works unset");
  assert.equal(commandLine(`<@${AUTO}> stay\n<@${AUTO}> move done`, AUTO), "move done");
  for (const text of [
    "No command here.",
    `I'll tell <@${AUTO}> later`,
    `&gt; <@${AUTO}> move done`,
    `\`<@${AUTO}> move done\``,
    `\`\`\`\n<@${AUTO}> move done\n\`\`\``,
    "@Autolinearbot move done",
    `<@U0SOMEONE1> move done`,
  ])
    assert.equal(commandLine(text, AUTO), null, text);
});

test("move takes a status, then keys, with quotes for spaces", () => {
  assert.deepEqual(parseCommand("move done"), {
    ok: true,
    command: { verb: "move", status: "done", keys: {} },
  });
  assert.deepEqual(parseCommand('move "Awaiting Others" who="Apple App Review".'), {
    ok: true,
    command: { verb: "move", status: "Awaiting Others", keys: { who: "Apple App Review" } },
  });
  assert.deepEqual(
    parseCommand("MOVE awaiting listener event=“Rogers &amp; Fido” STOP=2026-12-01"),
    {
      ok: true,
      command: {
        verb: "move",
        status: "awaiting listener",
        keys: { event: "Rogers & Fido", stop: "2026-12-01" },
      },
    },
  );
  assert.deepEqual(parseCommand("stay."), { ok: true, command: { verb: "stay" } });
  assert.deepEqual(parseCommand("help"), { ok: true, command: { verb: "help" } });
});

test("a command that doesn't read says why", () => {
  for (const [words, error] of [
    ["", "there's no command after my name"],
    ["done", "`done` isn't a command; use `move`, `stay` or `help`"],
    ["move", "`move` needs a status, such as `move done`"],
    ["move who=x", "`move` needs a status, such as `move done`"],
    [
      "move others colour=red",
      "`colour` isn't a key I know; use `who`, `start`, `event`, `stop`, `due`",
    ],
    ["move others who=", "`who` has no value"],
    ["move start=2026-12-01 date", "the status goes before the keys, not `date`"],
    ['move others who="Apple', "a quote isn't closed"],
    ["stay put", "`stay` takes nothing after it"],
  ])
    assert.deepEqual(parseCommand(words!), { ok: false, error }, words);
});

test("a status matches without regard to case, with or without Awaiting", () => {
  const statuses = ["Awaiting Init", "Awaiting Leon", "Executing", "Done"];
  assert.equal(matchStatus("leon", statuses), "Awaiting Leon");
  assert.equal(matchStatus("awaiting  LEON", statuses), "Awaiting Leon");
  assert.equal(matchStatus("Done", statuses), "Done");
  assert.equal(matchStatus("executing", statuses), "Executing");
  assert.equal(matchStatus("lion", statuses), null);
  assert.equal("[AWAITING: Apple App Review] ship it".replace(AWAITING_PREFIX, ""), "ship it");
});

test("Awaiting Hermes is only available in Linear", () => {
  for (const words of ["move hermes", "move Awaiting Hermes", "MOVE “Awaiting  HERMES”."])
    assert.deepEqual(parseCommand(words), {
      ok: false,
      error: "Awaiting Hermes is only available in Linear",
    });
  assert.doesNotMatch(commandUsage("@Autolinear"), /move hermes/i);
});
