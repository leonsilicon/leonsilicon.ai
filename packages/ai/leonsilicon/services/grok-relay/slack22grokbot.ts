import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  writeJsonAtomic,
  type ExtensionJournal,
  type JournalEntry,
} from "@-/ai.leonsilicon.services.beeper-inbox";
import { parseTaskBotName, taskBotName, type SlackThread } from "#handoff";
import type { GrokBackend, RelayLog } from "#types";

export interface RosterBot {
  id: string;
  name: string;
  created_at: string | null;
}

interface SlackReply {
  ts: string;
  from: string;
  author: string;
  userId?: string;
  text: string;
  files: string[];
}

export interface BridgeServices {
  slack: {
    thread(
      thread: SlackThread,
      after?: string,
    ): Promise<{ channel: string; cursor: string; replies: SlackReply[] }>;
    mirror(
      thread: SlackThread,
      message: {
        bot: string;
        eventId: string;
        text: string;
        retrySince?: string;
        slackTs?: string;
      },
    ): Promise<{ ts: string }>;
  };
  roster: {
    list(): Promise<RosterBot[]>;
    delete(id: string): Promise<void>;
  };
}

interface Mirror {
  started: string;
  ts?: string;
  digest?: string;
}

interface Route {
  name: string;
  chatID: string;
  thread: SlackThread;
  fromMs: number;
  beeperCursor: number;
  slackCursor: string;
  mirrors: Record<string, Mirror>;
  closing?: boolean;
}

interface State {
  started: number;
  journalStart: number;
  routes: Record<string, Route>;
  retired: string[];
}

interface BridgeOptions {
  backend: GrokBackend;
  journal: ExtensionJournal;
  services: BridgeServices;
  stateFile: string;
  hermesUserId?: string;
  log: RelayLog;
  now?: () => number;
}

const slackTs = (ms: number) => (ms / 1000).toFixed(6);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const messageText = (message: JournalEntry): string =>
  message.text.trim() ||
  (message.attachments
    ? "Sent an attachment in Grok Bot."
    : `Sent a ${message.type} message in Grok Bot.`);

/**
 * Single writer inside the Beeper inbox. The official Grok Bot connector delivers into the journal.
 * Each active roster bot has independent cursors, so one broken thread cannot stall the others.
 */
export class Slack22GrokBot {
  readonly #options: BridgeOptions;
  #state: State | undefined;
  #work: Promise<unknown> = Promise.resolve();
  #errors: Record<string, string> = {};
  #lastDirectoryRefresh = 0;

  constructor(options: BridgeOptions) {
    this.#options = options;
    try {
      this.#state = JSON.parse(readFileSync(options.stateFile, "utf8")) as State;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #save() {
    writeJsonAtomic(this.#options.stateFile, this.#state);
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#work.then(work);
    this.#work = next.catch(() => {});
    return next;
  }

  status() {
    return { active: Object.keys(this.#state?.routes ?? {}).length, errors: this.#errors };
  }

  retired(chatID: string): boolean {
    return this.#state?.retired.includes(chatID) ?? false;
  }

  async validate(thread: SlackThread): Promise<SlackThread> {
    const root = await this.#options.services.slack.thread(thread);
    return { ...thread, channel: root.channel };
  }

  async #initialize(): Promise<State> {
    if (!this.#state) {
      const started = this.#now();
      this.#state = {
        started,
        journalStart: await this.#options.journal.head(),
        routes: {},
        retired: [],
      };
      this.#save();
    }
    return this.#state;
  }

  tick(): Promise<void> {
    return this.#serial(async () => {
      const state = await this.#initialize();
      const { backend, services, log } = this.#options;
      const [roster, knownRooms] = await Promise.all([services.roster.list(), backend.bots()]);
      const errors: Record<string, string> = {};
      const recordError = (name: string, error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        errors[name] = message;
        if (this.#errors[name] !== message)
          log({ event: "slack22grokbot_route_error", bot: name, message });
      };
      const present = new Set(roster.map((bot) => bot.id));
      const tasks = roster.filter((bot) => parseTaskBotName(bot.name));
      let rooms = knownRooms;
      const now = this.#now();
      if (
        now - this.#lastDirectoryRefresh >= 60_000 &&
        tasks.some((bot) => !knownRooms.some((room) => room.name === bot.name))
      ) {
        this.#lastDirectoryRefresh = now;
        rooms = await backend.bots({ refresh: true });
      }
      const roomsByName = Map.groupBy(rooms, (room) => room.name);
      const tasksByName = Map.groupBy(tasks, (bot) => bot.name);
      // Keep progress for every route when one endpoint is unavailable.
      await Promise.all(
        Object.entries(state.routes)
          .filter(([id]) => !present.has(id))
          .map(async ([id, route]) => {
            try {
              if (await this.#mirror(route)) return;
              state.retired.push(route.chatID);
              delete state.routes[id];
              this.#save();
            } catch (error) {
              recordError(route.name, error);
            }
          })
          .concat(
            tasks.map(async (bot) => {
              try {
                const existing = state.routes[bot.id];
                if (existing?.closing) {
                  await this.#close(bot, existing);
                  return;
                }
                const matches = roomsByName.get(bot.name) ?? [];
                if (matches.length > 1 || tasksByName.get(bot.name)?.length !== 1)
                  throw new Error("Multiple Grok bots or Beeper conversations use this task name");
                const room = matches[0];
                if (!room) {
                  if (existing) throw new Error("The Grok conversation is missing from Beeper");
                  return;
                }
                if (existing && (existing.chatID !== room.chatID || existing.name !== bot.name))
                  throw new Error(
                    "The Grok task bot or its Beeper room changed after routing was established",
                  );
                const route = existing ?? (await this.#register(state, bot, room.chatID));
                await Promise.allSettled([this.#mirror(route), this.#forward(route)]).then(
                  (results) => {
                    const failed = results.find((result) => result.status === "rejected");
                    if (failed) throw failed.reason;
                  },
                );
              } catch (error) {
                recordError(bot.name, error);
              }
            }),
          ),
      );
      this.#errors = errors;
    });
  }

  async #register(state: State, bot: RosterBot, chatID: string): Promise<Route> {
    const named = parseTaskBotName(bot.name);
    if (!named) throw new Error("The Grok bot does not name a Slack task thread");
    const thread = await this.validate(named);
    if (
      Object.values(state.routes).some(
        (route) =>
          route.thread.channel === thread.channel && route.thread.threadTs === thread.threadTs,
      )
    )
      throw new Error("Another Grok bot already routes to this Slack thread");
    const fromMs = Math.max(state.started, Date.parse(bot.created_at ?? "") || 0);
    const route: Route = {
      name: bot.name,
      chatID,
      thread,
      fromMs,
      beeperCursor: state.journalStart,
      slackCursor: slackTs(fromMs) > thread.threadTs ? slackTs(fromMs) : thread.threadTs,
      mirrors: {},
    };
    state.routes[bot.id] = route;
    this.#save();
    return route;
  }

  async #mirror(route: Route): Promise<boolean> {
    const { journal, services } = this.#options;
    const page = await journal.changes({
      roomId: route.chatID,
      after: route.beeperCursor,
      limit: 50,
    });
    for (const message of page.entries) {
      if (!message.isMe && !message.redacted && message.ts >= route.fromMs) {
        const text = messageText(message);
        const digest = hash(text);
        const previous = route.mirrors[message.eventId];
        if (previous?.digest !== digest) {
          const delivery = previous ?? { started: slackTs(this.#now() - 60_000) };
          route.mirrors[message.eventId] = delivery;
          this.#save();
          const result = await services.slack.mirror(route.thread, {
            bot: route.name,
            eventId: message.eventId,
            text,
            ...(delivery.ts
              ? { slackTs: delivery.ts }
              : previous
                ? { retrySince: delivery.started }
                : {}),
          });
          delivery.ts = result.ts;
          delivery.digest = digest;
        }
      }
      route.beeperCursor = message.rev;
      this.#save();
    }
    return page.entries.length === 50;
  }

  async #forward(route: Route): Promise<void> {
    const { backend, services, hermesUserId } = this.#options;
    const page = await services.slack.thread(route.thread, route.slackCursor);
    for (const reply of page.replies) {
      const author =
        reply.from === "hermes" || (hermesUserId && reply.userId === hermesUserId)
          ? "Hermes"
          : reply.from === "leon"
            ? "Leon"
            : `${reply.author.replace(/\s+/g, " ").trim()} (other Slack participant)`;
      const files = reply.files.map((file) => `Slack attachment: ${file}`).join("\n");
      const text = [reply.text, files].filter(Boolean).join("\n");
      if (text.trim()) {
        const key = hash(`${route.thread.channel}/${reply.ts}`).slice(0, 40);
        // The matrix send ledger deduplicates the same Slack message after a timeout or restart.
        const characters = Array.from(text);
        for (let offset = 0; offset < characters.length; offset += 8_000) {
          const part = characters.slice(offset, offset + 8_000).join("");
          await backend.send(
            route.chatID,
            `Slack reply from ${author}:\n${part}`,
            `slack22grokbot-${key}-${offset}`,
          );
        }
      }
      route.slackCursor = reply.ts;
      this.#save();
    }
    route.slackCursor = page.cursor;
    this.#save();
  }

  async #close(bot: RosterBot, route?: Route): Promise<void> {
    const { services, log } = this.#options;
    if (route) {
      if (route.name !== bot.name) throw new Error("The Grok task bot was renamed before cleanup");
      await this.#mirror(route);
      const pending = await this.#options.journal.changes({
        roomId: route.chatID,
        after: route.beeperCursor,
        limit: 1,
      });
      if (pending.entries.length)
        throw new Error("Still copying Grok messages to Slack before cleanup");
    }
    await services.roster.delete(bot.id);
    if (route && this.#state) this.#state.retired.push(route.chatID);
    if (this.#state) delete this.#state.routes[bot.id];
    this.#save();
    log({ event: "slack22grokbot_task_closed", bot: bot.name, id: bot.id });
  }

  complete(thread: SlackThread): Promise<Record<string, unknown>> {
    return this.#serial(async () => {
      const state = await this.#initialize();
      const target = await this.validate(thread);
      const { backend, services } = this.#options;
      const roster = await services.roster.list();
      const matches = roster.filter((bot) => {
        const route = state.routes[bot.id];
        return (
          bot.name === taskBotName(target) ||
          bot.name === taskBotName(thread) ||
          (route?.thread.channel === target.channel && route.thread.threadTs === target.threadTs)
        );
      });
      if (!matches.length) return { ok: true, already_closed: true };
      if (matches.length > 1) throw new Error("More than one Grok bot names this Slack thread");
      const bot = matches[0]!;
      let route = state.routes[bot.id];
      if (!route) {
        const room = (await backend.bots({ refresh: true })).filter(
          (entry) => entry.name === bot.name,
        );
        if (room.length !== 1)
          throw new Error("Cannot find the Grok task's unique Beeper conversation");
        route = await this.#register(state, bot, room[0]!.chatID);
      }
      route.closing = true;
      this.#save();
      await this.#close(bot, route);
      return { ok: true, deleted: bot.name };
    });
  }
}
