#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mainRevision, mirrorNames, syncMirror } from "#mirror";

const organization = "leonsiliconAI";
const sourceRepository = "https://github.com/leonsilicon/leonsilicon.ai.git";

function sync(): void {
  const cwd = process.cwd();
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (mainRevision(sourceRepository, cwd) !== source) {
    console.log("A newer main commit is available. Its CI run will publish the mirrors.");
    return;
  }

  const token = process.env.HERMES_MIRROR_TOKEN;
  if (!token)
    throw new Error("Set HERMES_MIRROR_TOKEN to a token with write access to the mirrors.");
  // Give Git the header through its environment so it stays out of arguments and Git config files.
  const index = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const header = Buffer.from(`x-access-token:${token}`).toString("base64");
  const pushEnvironment = {
    ...process.env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: "http.https://github.com/.extraheader",
    [`GIT_CONFIG_VALUE_${index}`]: `Authorization: Basic ${header}`,
  };

  const failures: string[] = [];
  for (const name of mirrorNames(source, cwd)) {
    const url = `https://github.com/${organization}/${name}.git`;
    try {
      console.log(
        syncMirror({ name, source, fetchUrl: url, pushUrl: url, cwd, env: pushEnvironment }),
      );
    } catch (error) {
      failures.push(name);
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length) throw new Error(`Mirror publication failed for ${failures.join(", ")}`);
}

sync();
