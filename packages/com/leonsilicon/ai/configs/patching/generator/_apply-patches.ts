#!/usr/bin/env node
import { applyPatch, verifyPatch } from "#patch-runner";

const [name = "unsnooze", root, ...extra] = process.argv
  .slice(2)
  .filter((argument) => argument !== "--");
if (extra.length) throw new Error("Usage: _apply-patches [unsnooze] [package-directory]");
const changes = applyPatch(name, root);
if (!changes.length) console.log(`${name}: patch is already applied.`);
verifyPatch(name, root);
