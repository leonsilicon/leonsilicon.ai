import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { DaemonExtension, ExtensionContext } from "#extension";

const SYNC_URL = "https://linear-slack.leonsilicon.ai/matrix/issue-metadata";
const POLL_MS = 10_000;
const DIRECTORY_REFRESH_MS = 60_000;

interface Snapshot {
  teamId: string;
  closedProjectChannelIds?: unknown;
  records: Array<Record<string, unknown> & { channelId: string; identifier: string }>;
  projectAppearances?: Array<{ channelId: string; color: string | null; icon: string | null }>;
}

interface RoomWrite {
  kind: "issue" | "project";
  roomId: string;
  record: Record<string, unknown>;
  signature: string;
}

interface SlackRoom {
  room_id: string;
  name: string;
  is_direct?: boolean;
  bridge?: { channel_id?: string; network_id?: string; room_type?: string };
}

async function slackRooms(context: ExtensionContext, teamId: string, refresh: boolean) {
  const byChannel = new Map<string, SlackRoom[]>();
  let offset = 0;
  for (;;) {
    const page = await context.tool("list_conversations", {
      network: "slack",
      limit: 100,
      offset,
      refresh: refresh && offset === 0,
    });
    for (const room of page.conversations as SlackRoom[]) {
      const { channel_id: id, network_id: network, room_type: type } = room.bridge ?? {};
      if (!id || room.is_direct || type === "dm" || type === "group_dm" || type === "space")
        continue;
      const composite = /^(T[A-Z0-9]+)-([CG][A-Z0-9]+)$/.exec(id);
      const channel = composite?.[2] ?? id;
      if ((composite?.[1] ?? network) !== teamId || !/^[CG][A-Z0-9]+$/.test(channel)) continue;
      const rooms = byChannel.get(channel) ?? [];
      rooms.push(room);
      byChannel.set(channel, rooms);
    }
    if (typeof page.next_offset !== "number" || page.next_offset <= offset) return byChannel;
    offset = page.next_offset;
  }
}

export function linearIssueMetadataExtension(): DaemonExtension {
  return {
    name: "linear-issue-metadata",
    start(context) {
      let settings: ReturnType<typeof parseEnv>;
      try {
        settings = parseEnv(readFileSync(join(context.home, "env"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { status: () => ({ running: false, reason: "no settings file" }) };
      }
      const token = settings.LINEAR_ISSUE_METADATA_TOKEN?.trim();
      if (!token) throw new Error("Linear issue metadata needs LINEAR_ISSUE_METADATA_TOKEN");

      let directory = new Map<string, SlackRoom[]>();
      let nextDirectoryRefresh = 0;
      let stopped = false;
      let active = Promise.resolve();
      let failure: string | null = null;
      let lastSuccess: string | null = null;
      let unmatched = 0;
      let unmatchedProjects = 0;
      const published = { issue: new Map<string, string>(), project: new Map<string, string>() };
      let publishedProjectVisibility: string | null = null;

      async function publish() {
        const response = await fetch(SYNC_URL, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`snapshot request: HTTP ${response.status}`);
        const { teamId, records, closedProjectChannelIds, projectAppearances } =
          (await response.json()) as Snapshot;
        if (!/^T[A-Z0-9]+$/.test(teamId) || !Array.isArray(records))
          throw new Error("invalid Linear issue snapshot");
        if (Date.now() >= nextDirectoryRefresh) {
          directory = await slackRooms(context, teamId, true);
          nextDirectoryRefresh = Date.now() + DIRECTORY_REFRESH_MS;
        }

        let withoutRoom = 0;
        let projectsWithoutRoom = 0;
        let failed = 0;
        const writes: RoomWrite[] = [];
        for (const record of records) {
          const identifier = record.identifier.toLowerCase();
          const rooms = directory.get(record.channelId)?.filter((room) => {
            const name = room.name?.toLowerCase().replace(/^#/, "");
            return name === identifier || name?.startsWith(`${identifier}-`);
          });
          if (!rooms?.length) {
            withoutRoom++;
            continue;
          }
          const signature = JSON.stringify(record);
          for (const room of rooms) {
            if (published.issue.get(room.room_id) !== signature)
              writes.push({ kind: "issue", roomId: room.room_id, record, signature });
          }
        }
        for (const { channelId, color, icon } of projectAppearances ?? []) {
          const rooms = directory.get(channelId);
          if (!rooms?.length) {
            projectsWithoutRoom++;
            continue;
          }
          const record = { version: 1, teamId, channelId, color, icon };
          const signature = JSON.stringify(record);
          for (const room of rooms) {
            if (published.project.get(room.room_id) !== signature)
              writes.push({ kind: "project", roomId: room.room_id, record, signature });
          }
        }
        unmatched = withoutRoom;
        unmatchedProjects = projectsWithoutRoom;
        for (let start = 0; start < writes.length && !stopped; start += 8) {
          await Promise.all(
            writes.slice(start, start + 8).map(async ({ kind, roomId, record, signature }) => {
              try {
                if (kind === "issue") await context.publishLinearIssue(roomId, record);
                else await context.publishProjectAppearance(roomId, record);
                published[kind].set(roomId, signature);
              } catch (error) {
                failed++;
                if (failed === 1)
                  context.log("warn", "Linear room account data write failed", {
                    kind,
                    error: String(error),
                  });
              }
            }),
          );
        }
        if (closedProjectChannelIds != null && !stopped) {
          if (
            !Array.isArray(closedProjectChannelIds) ||
            !closedProjectChannelIds.every(
              (id) => typeof id === "string" && /^[CG][A-Z0-9]+$/.test(id),
            )
          )
            throw new Error("invalid project visibility snapshot");
          const visibility = { version: 1, teamId, closedChannelIds: closedProjectChannelIds };
          const signature = JSON.stringify(visibility);
          if (publishedProjectVisibility !== signature) {
            await context.publishProjectVisibility(visibility);
            publishedProjectVisibility = signature;
          }
        }
        if (failed) throw new Error(`${failed} room writes failed`);
        lastSuccess = new Date().toISOString();
      }

      function tick() {
        active = publish()
          .then(() => {
            failure = null;
          })
          .catch((error) => {
            failure = String(error);
            context.log("warn", "Linear issue snapshot cycle failed", { error: failure });
          })
          .finally(() => {
            if (!stopped) timer = setTimeout(tick, POLL_MS);
          });
      }
      let timer = setTimeout(tick, 0);
      return {
        status: () => ({
          running: !stopped,
          lastSuccess,
          published: published.issue.size,
          publishedProjects: published.project.size,
          projectVisibilityPublished: publishedProjectVisibility !== null,
          unmatched,
          unmatchedProjects,
          failure,
        }),
        async stop() {
          stopped = true;
          clearTimeout(timer);
          await active;
        },
      };
    },
  };
}
