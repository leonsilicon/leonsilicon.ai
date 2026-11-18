import { fileURLToPath } from "node:url";

export const pluginName = "beeper-watch-notification-guard";

/** Copy pluginFiles into the matching directory beneath $HERMES_HOME/plugins. */
export const pluginDirectory = fileURLToPath(new URL(".", import.meta.url));

export const pluginFiles = ["plugin.yaml", "__init__.py"] as const;
