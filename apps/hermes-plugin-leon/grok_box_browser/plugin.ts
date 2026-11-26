import { fileURLToPath } from "node:url";

/** Hermes plugin name, as listed in `plugins.enabled`. */
export const pluginName = "grok-box-browser";

/** The `browser.cloud_provider` value that selects this plugin's browsers. */
export const providerName = "grok-box";

/** Directory to copy (without `__tests__/`) to `$HERMES_HOME/plugins/grok-box-browser/`. */
export const pluginDirectory = fileURLToPath(new URL(".", import.meta.url));

/** Files that make up the deployed plugin. */
export const pluginFiles = [
  "plugin.yaml",
  "__init__.py",
  "pyproject.toml",
  "_bridge.py",
  "bridge.cjs",
  "policy.cjs",
] as const;

/** Files the Grok box fetches from the public mirror, pinned to a commit. */
export const boxFiles = ["box/up.sh", "box/broker.mjs"] as const;
