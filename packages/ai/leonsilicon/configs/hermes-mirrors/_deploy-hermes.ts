#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { deploy, deployPlugins } from "#deploy";

// After the mirror sync: install each mirror's main on Hermes Cloud and wait for the result.
const url = process.env.HERMES_URL;
const token = process.env.HERMES_DEPLOY_TOKEN;
if (!url || !token) throw new Error("Set HERMES_URL and HERMES_DEPLOY_TOKEN.");

const cwd = process.cwd();
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: id } = process.env;
const record = await deploy({
  url,
  token,
  source,
  plugins: deployPlugins(source, cwd),
  run: server && repository && id ? `${server}/${repository}/actions/runs/${id}` : undefined,
});
if (record.status === "failed") process.exitCode = 1;
