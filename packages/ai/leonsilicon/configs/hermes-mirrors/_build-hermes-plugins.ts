#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname } from "node:path";
// The worker first: each plugin's build copies it.
execFileSync("vp", ["-C", "packages/ai/leonsilicon/configs/hermes-mirrors", "pack"], {
  stdio: "inherit",
});
for (const config of globSync("apps/hermes-plugin-*/vite.config.ts").sort()) {
  const project = dirname(config);
  execFileSync("vp", ["-C", project, "pack"], { stdio: "inherit" });
}
