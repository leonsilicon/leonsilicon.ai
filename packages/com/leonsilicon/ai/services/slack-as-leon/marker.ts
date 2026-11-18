import { randomUUID } from "node:crypto";

/**
 * First group of the `client_msg_id` on every message this service posts. Slack keeps the id and
 * delivers it in the message event, and Hermes's `slack-as-leon-guard` plugin drops events that
 * carry it, so Hermes never answers its own messages as if Leon had written them. Messages Leon
 * types get a random UUID from his Slack client. Keep in sync with `MARKER` in that plugin.
 */
export const CLIENT_MSG_ID_PREFIX = "de1e6a7e";

/** A fresh UUID whose first group is the marker. */
export function newClientMsgId(): string {
  return `${CLIENT_MSG_ID_PREFIX}${randomUUID().slice(8)}`;
}

/** True when a message's `client_msg_id` says this service posted it. */
export function isMarked(clientMsgId: unknown): boolean {
  return typeof clientMsgId === "string" && clientMsgId.startsWith(`${CLIENT_MSG_ID_PREFIX}-`);
}
