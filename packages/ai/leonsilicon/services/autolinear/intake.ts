import {
  autolinearIssueId,
  channelName,
  escapeSlack,
  intakeTitle,
  parseTitle,
  SlackError,
  slackToLinear,
} from "@-/ai.leonsilicon.services.slack22linear";
import type {
  Adoption,
  LinearIssue,
  LinearTeam,
  NewIssue,
  SlackCall,
} from "@-/ai.leonsilicon.services.slack22linear";
import { newClientMsgId } from "@-/ai.leonsilicon.services.slack-as-leon";
import type { AutolinearConfig } from "#config";

export interface SlackFileRef {
  id?: string;
  name?: string;
  title?: string;
  permalink?: string;
}

/** One of Leon's Slack messages, as Hermes received it. */
export interface IntakeMessage {
  channel: string;
  ts: string;
  /** The thread it's in, when it's a reply. */
  threadTs?: string | null;
  user: string;
  /** Slack mrkdwn, as Slack sent it. */
  text: string;
  blocks?: unknown[];
  files?: SlackFileRef[];
  /** Where Leon wrote it, in words: `a DM with Hermes`, `#general`, `a thread in #feed-gmail`. */
  where: string;
}

export type IntakeResult =
  | {
      ok: true;
      issue: { id: string; identifier: string; url: string };
      channel: { id: string; name: string };
      /** The copy of Leon's message in the channel, which Hermes answers in his place. */
      ts: string;
      /** Where Leon wrote it, in words. */
      source: string;
      /** Milliseconds from the start until each step was done. */
      ms: Record<string, number>;
    }
  | { ok: false; skipped: "not_leon" | "issue_channel" | "not_project_channel" };

/** How far an intake got. Kept, so a retry carries on instead of starting over. */
export interface Progress {
  issue?: {
    id: string;
    identifier: string;
    number: number;
    title: string;
    url: string;
    state: string;
  };
  channel?: { id: string; name: string };
  linked?: boolean;
  copyTs?: string;
  copyClientMsgId?: string;
  /** Files shared to the copy that still need detaching from the source message. */
  filesToDetach?: string[];
  adopted?: boolean;
}

/** Lookups that stay true for a long time: kept for the life of the Worker's isolate. */
export interface IntakeCache {
  ids?: { teamId: string; stateId: string };
  workspaceUrl?: string | null;
}

export interface IntakeDeps {
  config: AutolinearConfig;
  linear: {
    issue(id: string): Promise<LinearIssue | null>;
    createIssue(input: NewIssue): Promise<LinearIssue>;
    team(key: string): Promise<LinearTeam | null>;
  };
  /** Leon's Slack web session: autolinear acts as him. */
  session: SlackCall;
  /** Hands the channel over to slack22linear (its Durable Object's `/adopt`). */
  adopt: (adoption: Adoption) => Promise<void>;
  progress: { get(): Promise<Progress>; put(progress: Progress): Promise<void> };
  cache?: IntakeCache;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * Makes one of Leon's Slack messages a Linear issue with its own channel (Leon's rule, 2026-11-21:
 * every message gets one at once, and Hermes answers it there). Only what Leon sees is on the way:
 *
 * 1. Creates the issue in Awaiting Init, one request: the team and status IDs come from config or
 *    a cache, and the title and description from the message itself.
 * 2. Creates its public channel `leon-<n>-<first words>` as Leon, so he is in it already.
 * 3. Posts a copy in the new channel and hands the channel to slack22linear in parallel.
 *    The copy carries slack-as-leon's marker, so Hermes handles it through its plugin.
 * 4. Once the copy is saved, replaces the original message with the channel link and detaches
 *    the files from the original.
 *
 * Each step is recorded, so a retry carries on where the last try stopped.
 */
export class Intake {
  readonly #d: IntakeDeps;
  readonly #now: () => number;
  readonly #cache: IntakeCache;

  constructor(deps: IntakeDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
    this.#cache = deps.cache ?? {};
  }

  async run(msg: IntakeMessage): Promise<IntakeResult> {
    const c = this.#d.config;
    const start = this.#now();
    const ms: Record<string, number> = {};
    const mark = (step: string) => {
      ms[step] = this.#now() - start;
    };
    if (msg.user !== c.leonUserId) return { ok: false, skipped: "not_leon" };
    if (new RegExp(`^(?:a thread in )?#${c.channelPrefix}-\\d+(?:-|$)`).test(msg.where))
      return { ok: false, skipped: "issue_channel" };
    // Leon 2026-11-26: only his DM with Hermes and project channels start issues. A reply in a
    // task channel whose name Hermes couldn't read arrives as "a channel" and stays there.
    if (!/^(?:a thread in )?(?:a DM with Hermes|#project-)/.test(msg.where))
      return { ok: false, skipped: "not_project_channel" };

    const p = await this.#d.progress.get();
    const save = () => this.#d.progress.put(p);
    // Both come from config or the isolate's cache, normally; on a cold start, asked in parallel.
    const [ids, workspaceUrl] = await Promise.all([
      p.issue ? null : this.#ids(),
      this.#workspaceUrl(),
    ]);
    const permalink = workspaceUrl ? permalinkOf(workspaceUrl, msg) : null;

    if (!p.issue) {
      const { teamId, stateId } = ids!;
      const [fields, id] = await Promise.all([
        this.#fields(msg, permalink),
        autolinearIssueId(`${msg.channel}:${msg.ts}`),
      ]);
      let issue: LinearIssue | null;
      try {
        issue = await this.#d.linear.createIssue({ id, teamId, stateId, ...fields });
      } catch (error) {
        // An earlier try got through.
        if (!/already exists|duplicate|unique/i.test(String(error))) throw error;
        issue = await this.#d.linear.issue(id);
        if (!issue) throw error;
      }
      p.issue = {
        id: issue.id,
        identifier: issue.identifier,
        number: issue.number,
        title: issue.title,
        url: issue.url,
        state: issue.state.name,
      };
      await save();
      mark("issue");
    }
    const issue = p.issue;

    if (!p.channel) {
      p.channel = await this.#createChannel(issue.number, issue.title);
      await save();
      mark("channel");
    }
    const channel = p.channel;

    const reply = Boolean(msg.threadTs && msg.threadTs !== msg.ts);
    const where = escapeSlack(msg.where);
    const lead = `From Leon's ${reply ? "reply" : "message"} in ${permalink ? `<${permalink}|${where}>` : where}.`;
    const copyAndLink = async () => {
      if (msg.files?.length && !p.filesToDetach) {
        const fileIds = await this.#fileIds(msg);
        if (p.copyTs) {
          // An intake started before file sharing was added may have a copy with file links.
          await this.#attachToCopy(channel.id, p.copyTs, fileIds);
        } else {
          if (!p.copyClientMsgId) {
            p.copyClientMsgId = newClientMsgId();
            await save();
          }
          p.copyTs = await this.#copy(msg, channel.id, fileIds, p.copyClientMsgId);
        }
        p.filesToDetach = fileIds;
        mark("copy");
        await save();
      } else if (!p.copyTs) {
        p.copyTs = await this.#copy(msg, channel.id, [], newClientMsgId());
        mark("copy");
        await save();
      }
      if (!p.linked) {
        p.linked = await this.#link(msg, channel.id);
        mark("linked");
        if (p.linked && p.filesToDetach?.length) await save();
      }
      if (p.linked && p.filesToDetach?.length) {
        const pending = p.filesToDetach;
        for (const [index, file] of pending.entries()) {
          await this.#detach(msg, file);
          p.filesToDetach = pending.slice(index + 1);
          await save();
        }
        mark("filesDetached");
      }
    };
    const steps = await Promise.allSettled([
      copyAndLink(),
      p.adopted
        ? null
        : this.#d
            .adopt({
              issueId: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              stateName: issue.state,
              channelId: channel.id,
              channelName: channel.name,
              sourceChannel: msg.channel,
              sourceTs: msg.ts,
              sourceThreadTs: reply ? msg.threadTs : null,
              lead,
            })
            .then(() => {
              p.adopted = true;
              mark("adopted");
            }),
    ]);
    await save();
    const failed = steps.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed) throw failed.reason;

    const result: IntakeResult = {
      ok: true,
      issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
      channel,
      ts: p.copyTs!,
      source: msg.where,
      ms,
    };
    this.#d.log?.("intake", { issue: issue.identifier, channel: channel.name, ms });
    return result;
  }

  /** The team's and the intake status's IDs: from config, else looked up once per isolate. */
  async #ids(): Promise<{ teamId: string; stateId: string }> {
    const c = this.#d.config;
    if (c.teamId && c.intakeStateId) return { teamId: c.teamId, stateId: c.intakeStateId };
    if (this.#cache.ids) return this.#cache.ids;
    const team = await this.#d.linear.team(c.teamKey);
    if (!team) throw new Error(`no Linear team ${c.teamKey}`);
    const state = team.states.find((s) => s.name === c.intakeState);
    if (!state) throw new Error(`no Linear status ${c.intakeState} in ${c.teamKey}`);
    this.#cache.ids = { teamId: c.teamId ?? team.id, stateId: c.intakeStateId ?? state.id };
    return this.#cache.ids;
  }

  /** `https://<workspace>.slack.com`: from config, else asked of Slack once per isolate. */
  async #workspaceUrl(): Promise<string | null> {
    if (this.#d.config.workspaceUrl) return this.#d.config.workspaceUrl;
    if (this.#cache.workspaceUrl !== undefined) return this.#cache.workspaceUrl;
    try {
      const url = (await this.#d.session("auth.test")).url;
      this.#cache.workspaceUrl = typeof url === "string" ? url.replace(/\/+$/, "") : null;
    } catch (error) {
      if (!(error instanceof SlackError)) throw error;
      this.#cache.workspaceUrl = null;
    }
    return this.#cache.workspaceUrl;
  }

  /** Title and description, from the message alone. Only other people's mentions need a lookup. */
  async #fields(msg: IntakeMessage, permalink: string | null) {
    const c = this.#d.config;
    const known = new Map([
      [c.leonUserId, "Leon"],
      [c.hermesUserId, "Hermes"],
    ]);
    const ids = [...new Set([...msg.text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]!))];
    await Promise.all(
      ids.filter((id) => !known.has(id)).map(async (id) => known.set(id, await this.#nameOf(id))),
    );
    const toMarkdown = (text: string) => slackToLinear(text, (id) => known.get(id) ?? id).trim();
    // "@Hermes can you…" is titled "can you…": the mention is how he talks to Hermes, not the task.
    const untagged = msg.text.replace(
      new RegExp(`<@${c.hermesUserId}(?:\\|[^>]*)?>[,:]?\\s*`, "g"),
      "",
    );
    const first = msg.files?.[0];
    const title = intakeTitle(
      toMarkdown(untagged),
      first ? `File: ${first.title || first.name || "untitled"}` : "Slack message",
    );
    const files = (msg.files ?? [])
      .filter((f) => f.permalink)
      .map((f) => `📎 [${f.title || f.name || "file"}](${f.permalink})`);
    const label = permalink ? `[${msg.where}](${permalink})` : msg.where;
    const description = [`**Leon in Slack** (${label}):`, toMarkdown(msg.text), ...files]
      .filter(Boolean)
      .join("\n\n");
    return { title, description };
  }

  async #nameOf(userId: string): Promise<string> {
    try {
      const info = await this.#d.session("users.info", { user: userId });
      const user = info.user as {
        name?: string;
        real_name?: string;
        profile?: { display_name?: string; real_name?: string };
      };
      return (
        user.profile?.display_name ||
        user.real_name ||
        user.profile?.real_name ||
        user.name ||
        userId
      );
    } catch (error) {
      if (!(error instanceof SlackError)) throw error;
      return userId;
    }
  }

  /** The issue's channel, public (Leon never wants private ones), made by Leon so he's in it at once. A taken name gets `-2`… */
  async #createChannel(number: number, title: string): Promise<{ id: string; name: string }> {
    const c = this.#d.config;
    const base = channelName(c.channelPrefix, number, parseTitle(title).name, c.channelNameMax);
    for (let attempt = 0; attempt < 5; attempt++) {
      const name = attempt === 0 ? base : `${base.slice(0, c.channelNameMax - 3)}-${attempt + 1}`;
      try {
        const created = await this.#d.session("conversations.create", { name, is_private: false });
        return { id: (created.channel as { id: string }).id, name };
      } catch (error) {
        if (error instanceof SlackError && error.code === "name_taken") continue;
        throw error;
      }
    }
    throw new Error(`no free channel name for ${base}`);
  }

  /** Replaces Leon's message with the channel link. Logs any Slack refusal and returns false. */
  async #link(msg: IntakeMessage, channelId: string): Promise<boolean> {
    try {
      await this.#d.session("chat.update", {
        channel: msg.channel,
        ts: msg.ts,
        text: `<#${channelId}>`,
        blocks: JSON.stringify([richText([{ type: "channel", channel_id: channelId }])]),
        attachments: "[]",
      });
      return true;
    } catch (error) {
      if (!(error instanceof SlackError)) throw error;
      this.#d.log?.("link_failed", { channel: msg.channel, ts: msg.ts, error: error.code });
      return false;
    }
  }

  async #slackMessage(channel: string, ts: string, threadTs?: string | null) {
    const exact = { channel, oldest: ts, latest: ts, inclusive: true };
    const response =
      threadTs && threadTs !== ts
        ? await this.#d.session("conversations.replies", { ...exact, ts: threadTs, limit: 5 })
        : await this.#d.session("conversations.history", { ...exact, limit: 1 });
    return (response.messages as SlackMessageCopy[] | undefined)?.find((m) => m.ts === ts);
  }

  async #fileIds(msg: IntakeMessage): Promise<string[]> {
    let files = msg.files ?? [];
    // Older Hermes plugins send file names and links without IDs.
    if (files.some((file) => !file.id)) {
      const source = await this.#slackMessage(msg.channel, msg.ts, msg.threadTs);
      files = source?.files ?? [];
    }
    const ids = files.map((file) => file.id);
    if (
      !ids.length ||
      !ids.every((id): id is string => typeof id === "string" && /^F[A-Z0-9]+$/.test(id))
    )
      throw new Error("Could not resolve the Slack message's attached file IDs");
    return [...new Set(ids)];
  }

  async #attachToCopy(channel: string, ts: string, fileIds: string[]): Promise<void> {
    const copy = await this.#slackMessage(channel, ts);
    if (!copy) throw new Error("Could not find the Slack copy to attach files");
    const currentIds = (copy.files ?? []).flatMap((file) => (file.id ? [file.id] : []));
    if (fileIds.every((id) => currentIds.includes(id))) return;
    const edited = await this.#d.session("chat.update", {
      channel,
      ts,
      text: copy.text || "(no text)",
      blocks: copy.blocks?.length ? JSON.stringify(copy.blocks) : undefined,
      file_ids: JSON.stringify([...new Set([...currentIds, ...fileIds])]),
    });
    const attached = (edited.message as SlackMessageCopy | undefined)?.files;
    if (!fileIds.every((id) => attached?.some((file) => file.id === id)))
      throw new Error("Slack did not confirm the files on the existing copy");
  }

  /** Removes this message's reference to the file, preserving the file and its other shares. */
  async #detach(msg: IntakeMessage, file: string): Promise<void> {
    try {
      await this.#d.session("chat.removeFile", { channel: msg.channel, ts: msg.ts, file });
    } catch (error) {
      // A previous attempt may have detached it before we could save progress.
      if (!(error instanceof SlackError)) throw error;
      const source = await this.#slackMessage(msg.channel, msg.ts, msg.threadTs);
      if (source?.files?.some((attached) => attached.id === file)) throw error;
    }
  }

  /** Posts as Leon with the same formatting and native Slack files. */
  async #copy(
    msg: IntakeMessage,
    channelId: string,
    fileIds: string[],
    clientMsgId: string,
  ): Promise<string> {
    const method = fileIds.length ? "files.share" : "chat.postMessage";
    const post = (blocks?: unknown[]) =>
      this.#d.session(method, {
        channel: channelId,
        client_msg_id: clientMsgId,
        ...(fileIds.length
          ? {
              files: fileIds.join(","),
              resharing_aware: true,
              comment: blocks ? undefined : msg.text || undefined,
            }
          : { text: msg.text || "(no text)" }),
        blocks: blocks ? JSON.stringify(blocks) : undefined,
      });
    let posted;
    if (msg.blocks?.length) {
      try {
        posted = await post(msg.blocks);
      } catch (error) {
        if (!(error instanceof SlackError) || error.code !== "invalid_blocks") throw error;
        posted = await post();
      }
    } else posted = await post();
    const ts = posted.file_msg_ts ?? posted.ts;
    if (typeof ts !== "string" || !ts) throw new Error(`Slack ${method} returned no timestamp`);
    return ts;
  }
}

interface SlackMessageCopy {
  ts: string;
  text?: string;
  blocks?: unknown[];
  files?: SlackFileRef[];
}

const richText = (elements: unknown[]) => ({
  type: "rich_text",
  elements: [{ type: "rich_text_section", elements }],
});

/** A Slack permalink, built without asking Slack. */
export function permalinkOf(
  workspaceUrl: string,
  msg: Pick<IntakeMessage, "channel" | "ts" | "threadTs">,
) {
  const link = `${workspaceUrl}/archives/${msg.channel}/p${msg.ts.replace(".", "")}`;
  return msg.threadTs && msg.threadTs !== msg.ts
    ? `${link}?thread_ts=${msg.threadTs}&cid=${msg.channel}`
    : link;
}
