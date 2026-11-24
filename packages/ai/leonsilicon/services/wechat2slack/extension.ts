import { beeperToSlackExtension } from "@-/ai.leonsilicon.services.beeper-to-slack";

export function wechat2slackExtension() {
  return beeperToSlackExtension({ name: "wechat2slack", network: "wechat" });
}
