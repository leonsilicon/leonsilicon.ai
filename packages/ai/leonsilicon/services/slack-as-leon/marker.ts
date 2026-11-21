import { randomUUID } from "node:crypto";

/**
 * First group of the `client_msg_id` on every message this service posts. Slack keeps the id and
 * delivers it in the message event. Everything that reacts to Leon's own messages skips posts that
 * carry it (autolinear, Linear Sync, Hermes's autolinear plugin): they are not his words. Messages
 * Leon types get a random UUID from his Slack client. Keep in sync with `MARKER` in Hermes's
 * `slack-as-leon-guard` and `autolinear` plugins.
 */
export const CLIENT_MSG_ID_PREFIX = "de1e6a7e";

/**
 * Who a post is for: Hermes's own posts as Leon, or another agent's posts to Hermes in the Slack
 * thread of a task Hermes handed it (a Grok Bot bot, or a Codex session Silicon Dot started).
 */
export type Poster = "hermes" | "grok" | "codex";

/** An agent that talks to Hermes in a task thread. */
export type Agent = Exclude<Poster, "hermes">;

/**
 * Second group on an agent's posts (`de1e6a7e-b075-…` for a Grok bot, `de1e6a7e-c0de-…` for Codex).
 * Hermes's `slack-as-leon-guard` drops Hermes's own posts but lets these through, labelled as the
 * agent's, so Hermes answers them; Hermes's own posts never use either group.
 */
export const AGENT_GROUPS: Readonly<Record<Agent, string>> = { grok: "b075", codex: "c0de" };

/** The Grok bots' second group (`AGENT_GROUPS.grok`). */
export const GROK_BOT_GROUP = AGENT_GROUPS.grok;

/** A fresh UUID whose first group is the marker (and, for an agent's post, the second too). */
export function newClientMsgId(poster: Poster = "hermes"): string {
  const rest = randomUUID().slice(8); // "-xxxx-4xxx-yxxx-xxxxxxxxxxxx"
  if (poster !== "hermes") return `${CLIENT_MSG_ID_PREFIX}-${AGENT_GROUPS[poster]}${rest.slice(5)}`;
  if (Object.values(AGENT_GROUPS).some((group) => rest.startsWith(`-${group}-`)))
    return newClientMsgId(poster);
  return `${CLIENT_MSG_ID_PREFIX}${rest}`;
}

/** True when a message's `client_msg_id` says this service posted it (for Hermes or an agent). */
export function isMarked(clientMsgId: unknown): boolean {
  return typeof clientMsgId === "string" && clientMsgId.startsWith(`${CLIENT_MSG_ID_PREFIX}-`);
}

/** Which agent posted it through this service, or null for Hermes's posts and everyone else's. */
export function agentOf(clientMsgId: unknown): Agent | null {
  if (typeof clientMsgId !== "string") return null;
  for (const [agent, group] of Object.entries(AGENT_GROUPS) as [Agent, string][])
    if (clientMsgId.startsWith(`${CLIENT_MSG_ID_PREFIX}-${group}-`)) return agent;
  return null;
}

/** True when a Grok bot posted it through this service, to talk to Hermes. */
export const isGrokBotPost = (clientMsgId: unknown): boolean => agentOf(clientMsgId) === "grok";

/** True when an agent (a Grok bot or a Codex session) posted it, to talk to Hermes. */
export const isAgentPost = (clientMsgId: unknown): boolean => agentOf(clientMsgId) !== null;
