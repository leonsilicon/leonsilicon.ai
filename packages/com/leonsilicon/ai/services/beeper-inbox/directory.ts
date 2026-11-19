import type { DatabaseSync } from "node:sqlite";

/**
 * What `list_conversations` searches: one row per joined room with its name, network and last
 * activity. It's metadata only (no message text), rebuilt from one filtered `/sync` and kept fresh by
 * the daemon's live sync. Room IDs are stored exactly as the homeserver gives them.
 */

export interface BridgeInfo {
  stateKey: string;
  protocolId: string | null;
  protocolName: string | null;
  channelName: string | null;
  channelId: string | null;
  receiver: string | null;
  bridgeBot: string | null;
  roomType: string | null;
}

export interface RoomRecord {
  roomId: string;
  name: string | null;
  /** Short network name, as the Slack feed channels use it: whatsapp, instagram, imessage, beeper… */
  network: string;
  bridge: BridgeInfo | null;
  isDirect: boolean;
  memberCount: number | null;
  encrypted: boolean;
  canonicalAlias: string | null;
  lastEventTs: number | null;
  lastSender: string | null;
  tags: string[];
  heroes: string[];
  updatedAt: number;
}

const NETWORK_ALIASES: Record<string, string> = {
  matrix: "beeper",
  hungryserv: "beeper",
  twitter: "x",
  facebook: "messenger",
  gmessages: "sms",
  gvoice: "google-voice",
  googlechat: "google-chat",
  "chatgpt-dots": "chatgpt",
  grokbot: "grok",
};

export function normalizeNetwork(protocolId: string | null | undefined): string {
  if (!protocolId) return "beeper";
  let id = protocolId.toLowerCase().replace(/^local-/, "");
  id = id.replace(/^(.{3,})go$/, "$1");
  return NETWORK_ALIASES[id] ?? (id.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "other");
}

interface StateEvent {
  type?: string;
  state_key?: string;
  content?: Record<string, unknown>;
  sender?: string;
  origin_server_ts?: number;
}

interface SyncRoom {
  state?: { events?: StateEvent[] };
  timeline?: { events?: StateEvent[] };
  summary?: {
    "m.heroes"?: string[];
    "m.joined_member_count"?: number;
    "m.invited_member_count"?: number;
  };
  account_data?: { events?: StateEvent[] };
}

export interface SyncBody {
  rooms?: { join?: Record<string, SyncRoom> };
  account_data?: { events?: StateEvent[] };
}

/** The `/sync` filter for a directory refresh: room metadata and each room's latest event, nothing else. */
export const DIRECTORY_FILTER = {
  presence: { types: [] as string[] },
  account_data: { types: ["m.direct"] },
  room: {
    state: {
      types: [
        "m.room.name",
        "m.room.canonical_alias",
        "m.room.encryption",
        "m.room.member",
        "m.room.tombstone",
        "m.bridge",
        "uk.half-shot.bridge",
      ],
      lazy_load_members: true,
    },
    timeline: { limit: 1, lazy_load_members: true },
    ephemeral: { types: [] as string[] },
    account_data: { types: ["m.tag"] },
    include_leave: false,
  },
};

export function bridgeFrom(events: readonly StateEvent[]): BridgeInfo | null {
  const bridges = events.filter(
    (event) => event.type === "m.bridge" || event.type === "uk.half-shot.bridge",
  );
  const event = bridges.find((candidate) => candidate.type === "m.bridge") ?? bridges[0];
  if (!event?.content) return null;
  const content = event.content;
  const protocol = (content.protocol ?? {}) as Record<string, unknown>;
  const channel = (content.channel ?? {}) as Record<string, unknown>;
  const str = (value: unknown): string | null =>
    typeof value === "string" && value ? value : null;
  return {
    stateKey: event.state_key ?? "",
    protocolId: str(protocol.id),
    protocolName: str(protocol.displayname),
    channelName: str(channel.displayname),
    channelId: str(channel.id),
    receiver: str(channel.receiver),
    bridgeBot: str(content.bridgebot),
    roomType: str(content["com.beeper.room_type"]) ?? str(content["com.beeper.room_type.v2"]),
  };
}

/** Builds directory rows from a filtered sync response. Exported for tests. */
export function roomsFromSync(body: SyncBody, ownUserId: string, now = Date.now()): RoomRecord[] {
  const direct = new Set<string>();
  for (const event of body.account_data?.events ?? []) {
    if (event.type !== "m.direct" || !event.content) continue;
    for (const rooms of Object.values(event.content)) {
      if (Array.isArray(rooms))
        for (const room of rooms) if (typeof room === "string") direct.add(room);
    }
  }
  const records: RoomRecord[] = [];
  for (const [roomId, room] of Object.entries(body.rooms?.join ?? {})) {
    const timeline = room.timeline?.events ?? [];
    const state = [
      ...(room.state?.events ?? []),
      ...timeline.filter((event) => event.state_key !== undefined),
    ];
    const latest = (type: string): StateEvent | undefined =>
      state.filter((event) => event.type === type).at(-1);
    const name = latest("m.room.name")?.content?.name;
    const alias = latest("m.room.canonical_alias")?.content?.alias;
    const bridge = bridgeFrom(state);
    const heroes = (room.summary?.["m.heroes"] ?? []).filter((user) => user !== ownUserId);
    const members = new Map<string, string>();
    for (const event of state) {
      if (
        event.type === "m.room.member" &&
        event.state_key &&
        typeof event.content?.displayname === "string"
      ) {
        members.set(event.state_key, event.content.displayname);
      }
    }
    const heroNames = heroes.map((user) => members.get(user) ?? user);
    const last = timeline.at(-1);
    const tags = room.account_data?.events?.find((event) => event.type === "m.tag")?.content?.tags;
    const joined = room.summary?.["m.joined_member_count"];
    records.push({
      roomId,
      name:
        typeof name === "string" && name.trim()
          ? name.trim()
          : heroNames.length
            ? heroNames.join(", ")
            : null,
      network: normalizeNetwork(bridge?.protocolId),
      bridge,
      isDirect:
        direct.has(roomId) ||
        bridge?.roomType === "dm" ||
        (typeof joined === "number" && joined <= 2 && !name),
      memberCount: typeof joined === "number" ? joined : null,
      encrypted: state.some((event) => event.type === "m.room.encryption"),
      canonicalAlias: typeof alias === "string" ? alias : null,
      lastEventTs: typeof last?.origin_server_ts === "number" ? last.origin_server_ts : null,
      lastSender: typeof last?.sender === "string" ? last.sender : null,
      tags: tags && typeof tags === "object" ? Object.keys(tags) : [],
      heroes: heroNames,
      updatedAt: now,
    });
  }
  return records;
}

interface Row {
  room_id: string;
  name: string | null;
  network: string;
  bridge: string | null;
  is_direct: number;
  member_count: number | null;
  encrypted: number;
  canonical_alias: string | null;
  last_event_ts: number | null;
  last_sender: string | null;
  tags: string;
  heroes: string;
  updated_at: number;
}

export interface DirectorySearch {
  query?: string;
  network?: string;
  isDirect?: boolean;
  limit: number;
  offset: number;
}

export class RoomDirectory {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      name TEXT,
      network TEXT NOT NULL,
      bridge TEXT,
      is_direct INTEGER NOT NULL,
      member_count INTEGER,
      encrypted INTEGER NOT NULL,
      canonical_alias TEXT,
      last_event_ts INTEGER,
      last_sender TEXT,
      tags TEXT NOT NULL,
      heroes TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(
      "CREATE TABLE IF NOT EXISTS directory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  /** Replaces the directory with a full refresh: rooms no longer joined disappear. */
  replaceAll(records: readonly RoomRecord[], now = Date.now()): void {
    this.#db.exec("BEGIN");
    try {
      this.#db.exec("DELETE FROM rooms");
      const insert = this.#db.prepare(
        `INSERT INTO rooms (room_id, name, network, bridge, is_direct, member_count, encrypted, canonical_alias, last_event_ts, last_sender, tags, heroes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const record of records) {
        insert.run(
          record.roomId,
          record.name,
          record.network,
          record.bridge ? JSON.stringify(record.bridge) : null,
          record.isDirect ? 1 : 0,
          record.memberCount,
          record.encrypted ? 1 : 0,
          record.canonicalAlias,
          record.lastEventTs,
          record.lastSender,
          JSON.stringify(record.tags),
          JSON.stringify(record.heroes),
          record.updatedAt,
        );
      }
      this.#db
        .prepare("INSERT OR REPLACE INTO directory_meta (key, value) VALUES ('refreshed_at', ?)")
        .run(String(now));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Live sync saw activity in a room. */
  touch(roomId: string, ts: number, sender: string | null): void {
    this.#db
      .prepare(
        "UPDATE rooms SET last_event_ts = MAX(COALESCE(last_event_ts, 0), ?), last_sender = COALESCE(?, last_sender) WHERE room_id = ?",
      )
      .run(ts, sender, roomId);
  }

  rename(roomId: string, name: string): void {
    this.#db.prepare("UPDATE rooms SET name = ? WHERE room_id = ?").run(name, roomId);
  }

  refreshedAt(): number | null {
    const row = this.#db
      .prepare("SELECT value FROM directory_meta WHERE key = 'refreshed_at'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) : null;
  }

  count(): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM rooms").get() as { n: number }).n);
  }

  networks(): Array<{ network: string; rooms: number }> {
    return (
      this.#db
        .prepare(
          "SELECT network, COUNT(*) AS rooms FROM rooms GROUP BY network ORDER BY rooms DESC",
        )
        .all() as unknown as Array<{
        network: string;
        rooms: number;
      }>
    ).map((row) => ({ network: row.network, rooms: Number(row.rooms) }));
  }

  get(roomId: string): RoomRecord | null {
    const row = this.#db.prepare("SELECT * FROM rooms WHERE room_id = ?").get(roomId) as
      | Row
      | undefined;
    return row ? fromRow(row) : null;
  }

  search(options: DirectorySearch): { rooms: RoomRecord[]; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.query) {
      const like = `%${options.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      where.push(
        "(name LIKE ? ESCAPE '\\' OR heroes LIKE ? ESCAPE '\\' OR canonical_alias LIKE ? ESCAPE '\\' OR room_id = ? OR bridge LIKE ? ESCAPE '\\')",
      );
      params.push(like, like, like, options.query, like);
    }
    if (options.network) {
      where.push("network = ?");
      params.push(normalizeNetwork(options.network));
    }
    if (options.isDirect !== undefined) {
      where.push("is_direct = ?");
      params.push(options.isDirect ? 1 : 0);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = Number(
      (
        this.#db.prepare(`SELECT COUNT(*) AS n FROM rooms ${clause}`).get(...params) as {
          n: number;
        }
      ).n,
    );
    const rows = this.#db
      .prepare(
        `SELECT * FROM rooms ${clause} ORDER BY COALESCE(last_event_ts, 0) DESC, room_id LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit, options.offset) as unknown as Row[];
    return { rooms: rows.map(fromRow), total };
  }
}

function fromRow(row: Row): RoomRecord {
  return {
    roomId: row.room_id,
    name: row.name,
    network: row.network,
    bridge: row.bridge ? (JSON.parse(row.bridge) as BridgeInfo) : null,
    isDirect: row.is_direct === 1,
    memberCount: row.member_count,
    encrypted: row.encrypted === 1,
    canonicalAlias: row.canonical_alias,
    lastEventTs: row.last_event_ts,
    lastSender: row.last_sender,
    tags: JSON.parse(row.tags) as string[],
    heroes: JSON.parse(row.heroes) as string[],
    updatedAt: row.updated_at,
  };
}
