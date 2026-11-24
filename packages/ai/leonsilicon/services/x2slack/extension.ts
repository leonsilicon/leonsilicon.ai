import { beeperToSlackExtension } from "@-/ai.leonsilicon.services.beeper-to-slack";

export function x2slackExtension() {
  return beeperToSlackExtension({ name: "x2slack", network: "x" });
}
