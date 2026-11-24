import { beeperToSlackExtension } from "@-/ai.leonsilicon.services.beeper-to-slack";

export function instagram2slackExtension() {
  return beeperToSlackExtension({ name: "instagram2slack", network: "instagram" });
}
