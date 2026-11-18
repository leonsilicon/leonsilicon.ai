import { startBeeperWatch } from "@-/com.leonsilicon.ai.services.beeper-watch";

const service = await startBeeperWatch();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => void service.stop().then(() => process.exit(0)));
