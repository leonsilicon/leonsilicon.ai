#!/usr/bin/env node
import { generatePatch } from "#patch-runner";

const [name, root, ...extra] = process.argv.slice(2).filter((argument) => argument !== "--");
if (!name || !root || extra.length)
  throw new Error("Usage: _generate-patches unsnooze /path/to/pristine/package");
console.log(generatePatch(name, root));
