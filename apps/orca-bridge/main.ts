import { createListener, loadConfig, VERSION } from "@-/ai.leonsilicon.services.orca-bridge";

const config = loadConfig();
const listener = createListener(config);
listener.listen(config.port, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      service: "orca-bridge",
      version: VERSION,
      listening: `127.0.0.1:${config.port}`,
      environments: config.environments,
    }),
  ),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => listener.close(() => process.exit(0)));
