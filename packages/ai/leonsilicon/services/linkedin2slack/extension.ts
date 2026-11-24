import { beeperToSlackExtension } from "@-/ai.leonsilicon.services.beeper-to-slack";

export function linkedin2slackExtension() {
  return beeperToSlackExtension({ name: "linkedin2slack", network: "linkedin" });
}
