import { execFile } from "node:child_process";
import type { OrcaBridgeConfig } from "#config";

// Leon granted the Slack agents full Orca access on 2026-11-05, computer use included. Only commands
// that cannot work through a stateless request, or that would pair or unpair runtimes, are refused.
const DENIED = new Map([
  ["serve", "starts a long-running server and never returns"],
  ["plugin dev watch", "streams until interrupted and never returns"],
  ["environment add", "pairing new runtimes is unavailable through this connection"],
  ["environment rm", "removing paired runtimes is unavailable through this connection"],
  ["pair", "creating pairing offers is unavailable through this connection"],
]);

export type CliResult = Record<string, unknown> & { ok?: unknown };

export class CliRefused extends Error {}

/** Throws CliRefused when `args` may not run through this connection. */
export function checkArgs(
  args: unknown,
  stdin: unknown,
  environments: readonly string[],
): string[] {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.length > 120 ||
    args.some((x) => typeof x !== "string" || x.includes("\0") || x.length > 64_000)
  ) {
    throw new CliRefused("args must be a bounded array of literal CLI arguments");
  }
  if (stdin !== undefined && (typeof stdin !== "string" || stdin.length > 256_000))
    throw new CliRefused("stdin must be a string under 256 KB");
  const list = args as string[];
  for (const len of [3, 2, 1]) {
    const key = list.slice(0, len).join(" ");
    const why = DENIED.get(key);
    if (why) throw new CliRefused(`"${key}" is unavailable through this connection: ${why}`);
  }
  if (list.some((x) => x === "--pairing-code" || x.startsWith("--pairing-code=")))
    throw new CliRefused(
      `--pairing-code is unavailable; use --environment ${environments.map((e) => JSON.stringify(e)).join(" or ")}, or omit it for the Mac mini`,
    );
  list.forEach((x, i) => {
    const value =
      x === "--environment" ? list[i + 1] : x.startsWith("--environment=") ? x.slice(14) : null;
    if (value !== null && (value === undefined || !environments.includes(value)))
      throw new CliRefused(
        `Unknown environment ${JSON.stringify(value ?? "")}. Allowed: ${environments.map((e) => JSON.stringify(e)).join(", ")} (omit --environment for the Mac mini)`,
      );
  });
  return list;
}

/** The time a call may run: longer for launches and explicit waits, never past `maxCallMs`. */
export function timeoutFor(args: readonly string[], maxCallMs: number): number {
  const head = args.slice(0, 2).join(" ");
  let ms = ["worktree create", "agent launch", "orchestration worker-start"].includes(head)
    ? 180_000
    : 60_000;
  for (const flag of ["--timeout-ms", "--timeout"]) {
    const i = args.indexOf(flag);
    const n = i >= 0 ? Number(args[i + 1]) : Number.NaN;
    if (Number.isFinite(n) && n > 0) ms = Math.max(ms, n + 20_000);
  }
  return Math.min(ms, maxCallMs);
}

/** Runs `orca <args> --json` without a shell and returns Orca's JSON envelope (or an error envelope). */
export function runCli(
  config: Pick<OrcaBridgeConfig, "orcaBin" | "workingDirectory" | "environments" | "maxCallMs">,
  rawArgs: unknown,
  stdin?: unknown,
): Promise<CliResult> {
  const args = checkArgs(rawArgs, stdin, config.environments);
  const argv = args.includes("--json") || args.includes("--help") ? args : [...args, "--json"];
  return new Promise((done) => {
    const child = execFile(
      config.orcaBin,
      argv,
      {
        cwd: config.workingDirectory,
        timeout: timeoutFor(args, config.maxCallMs),
        maxBuffer: 16 * 1024 * 1024,
        // Only the --environment on argv picks a remote Orca, never an inherited variable.
        env: { ...process.env, ORCA_ENVIRONMENT: "", ORCA_PAIRING_CODE: "" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          try {
            return done(JSON.parse(stdout) as CliResult);
          } catch {
            return done({ ok: true, output: stdout.slice(-80_000) });
          }
        }
        if (stdout) {
          try {
            return done(JSON.parse(stdout) as CliResult);
          } catch {
            // fall through to the error envelope
          }
        }
        done({
          ok: false,
          error: {
            code: error.killed ? "command_timeout" : "orca_cli_error",
            message: String(stderr || error.message).slice(-8_000),
            ...(error.killed
              ? {
                  nextStep:
                    "Inspect state before retrying; a timed-out action may have been accepted.",
                }
              : {}),
          },
        });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(typeof stdin === "string" ? stdin : "");
  });
}
