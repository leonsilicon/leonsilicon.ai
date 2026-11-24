import { beeperToSlackExtension } from "@-/ai.leonsilicon.services.beeper-to-slack";

export function discord2slackExtension() {
  return beeperToSlackExtension({ name: "discord2slack", network: "discord" });
}
