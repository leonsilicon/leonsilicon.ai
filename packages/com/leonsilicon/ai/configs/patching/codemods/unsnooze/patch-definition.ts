import { fileURLToPath } from "node:url";
import { patchClaudeAdapter } from "#codemod";
import config from "#patch.json" with { type: "json" };

export const unsnoozePatch = {
  ...config,
  transform: patchClaudeAdapter,
  integrationTest: fileURLToPath(
    new URL("./__tests__/connection-loss.integration.mjs", import.meta.url),
  ),
} as const;
