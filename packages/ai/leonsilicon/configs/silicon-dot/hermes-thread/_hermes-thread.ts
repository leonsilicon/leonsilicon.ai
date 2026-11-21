#!/usr/bin/env node
// hermes-thread: talk to Hermes in a task's Slack thread from a shell, with the same two tools as the
// slack-puppet MCP server, for sessions that can run a command but don't get Codex's MCP servers
// (Silicon Dot's ChatGPT sessions). The token comes from the login Keychain.
//
//   hermes-thread send --channel C0123456789 --thread-ts 1795280000.123456 --from "Task slack:…" --text "…"
//   hermes-thread read --channel C0123456789 --ts <ts of your post> [--after <cursor>] [--wait 120]
//
// --text can be left out to read the message from stdin. Prints the tool's JSON; exits 1 on a refusal.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { callTool, keychainToken, KEYCHAIN_SERVICE } from "#hermes-thread";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    channel: { type: "string" },
    "thread-ts": { type: "string" },
    ts: { type: "string" },
    from: { type: "string" },
    text: { type: "string" },
    after: { type: "string" },
    wait: { type: "string" },
  },
  strict: true,
});
const usage = () => {
  process.stderr.write(
    "usage: hermes-thread send --channel C… --thread-ts <ts> --from <your title> [--text …|stdin] [--wait s]\n" +
      "       hermes-thread read --channel C… --ts <your post's ts> [--after <cursor>] [--wait s]\n",
  );
  process.exit(64);
};
if (command !== "send" && command !== "read") usage();
const token = keychainToken();
if (!token) {
  process.stderr.write(
    `hermes-thread: no slack-puppet token in the login Keychain (${KEYCHAIN_SERVICE}); run the installer (configs/silicon-dot/hermes-thread)\n`,
  );
  process.exit(1);
}
const wait = values.wait === undefined ? undefined : Number(values.wait);
const args: Record<string, unknown> =
  command === "send"
    ? {
        channel: values.channel,
        thread_ts: values["thread-ts"],
        from_bot: values.from,
        text: values.text ?? readFileSync(0, "utf8"),
        ...(wait === undefined ? {} : { wait_seconds: wait }),
      }
    : {
        channel: values.channel,
        ts: values.ts,
        ...(values.after ? { after: values.after } : {}),
        ...(wait === undefined ? {} : { wait_seconds: wait }),
      };
const { isError, result } = await callTool(
  command === "send" ? "hermes_thread_send" : "hermes_thread_read",
  args,
  token,
);
console.log(JSON.stringify(result, null, 1));
process.exit(isError ? 1 : 0);
