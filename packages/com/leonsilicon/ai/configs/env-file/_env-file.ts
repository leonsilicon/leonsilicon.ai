#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatEnvFile } from "#env-file";

// Prints the env file for one app: the items tagged #<app> in the root .env.schema, resolved by
// varlock (secrets from Infisical). Only that tag is resolved. Deploy scripts pipe the output over
// SSH, so the values are never written to disk here.
const app = process.argv[2];
if (!app || !/^[a-z0-9-]+$/.test(app)) {
  console.error("Usage: _env-file <app>   (an app tag in .env.schema, e.g. orca-bridge)");
  process.exit(2);
}
const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
let json: string;
try {
  json = execFileSync(
    `${root}node_modules/.bin/varlock`,
    ["load", "--path", root, "--filter", `#${app}`, "--format", "json", "--compact"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 20 },
  );
} catch {
  // varlock has already explained which items failed (with sensitive values redacted).
  console.error(
    `\nCould not resolve #${app} from .env.schema; is Infisical access set up in .env?`,
  );
  process.exit(1);
}
const values = JSON.parse(json) as Record<string, unknown>;
if (Object.keys(values).length === 0) {
  console.error(`No items are tagged #${app} in .env.schema`);
  process.exit(1);
}
process.stdout.write(
  formatEnvFile(
    values,
    `Written by the ${app} deploy script from leonsilicon.ai's .env.schema (#${app}), values from\nInfisical. Change them there; edits here are overwritten on the next deploy with --start.`,
  ),
);
