import { beeperToSlackExtension } from "@-/ai.leonsilicon.services.beeper-to-slack";

export function reddit2slackExtension() {
  return beeperToSlackExtension({ name: "reddit2slack", network: "reddit" });
}
