import { beeperToSlackExtension } from "@-/ai.leonsilicon.services.beeper-to-slack";

export function whatsapp2slackExtension() {
  return beeperToSlackExtension({ name: "whatsapp2slack", network: "whatsapp" });
}
