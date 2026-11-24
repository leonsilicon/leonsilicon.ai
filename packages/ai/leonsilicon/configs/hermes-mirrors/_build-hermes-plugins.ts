#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, globSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtime = fileURLToPath(new URL("./runtime/_pythonmonkey.py", import.meta.url));

for (const config of globSync("apps/hermes-plugin-*/vite.config.ts").sort()) {
  const project = dirname(config);
  execFileSync("vp", ["-C", project, "pack"], { stdio: "inherit" });
  copyFileSync(runtime, join(project, "_pythonmonkey.py"));
}
