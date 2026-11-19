export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** One SQL statement against SQLite: a Durable Object's `storage.sql`, or `node:sqlite` in tests. */
export interface Sql {
  exec(query: string, ...params: SqlValue[]): Row[];
}

export interface IssueRecord {
  issueId: string;
  identifier: string;
  title: string;
  stateName: string;
  channelId: string;
  channelName: string;
  /** The sidebar section the channel was last put in. */
  section: string | null;
  topic: string | null;
  archived: boolean;
}

export interface CommentRecord {
  commentId: string;
  issueId: string;
  channelId: string;
  slackTs: string;
  /** The Slack thread the message is in, when it's a reply. */
  threadTs: string | null;
  /** The top-level Linear comment of its thread (itself when top-level). */
  rootCommentId: string;
  origin: "linear" | "slack";
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  statusName: string;
  /** The channel Linear connected to the project; null until it has one. */
  channelId: string | null;
  /** The sidebar section the channel was last put in. */
  section: string | null;
  archived: boolean;
  /** When the sync last asked Linear to create the channel (ms), so it doesn't ask twice. */
  requestedAt: number | null;
}

export interface Job {
  id: string;
  kind: string;
  payload: string;
  attempts: number;
}

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS issues (
    issue_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, title TEXT NOT NULL, state_name TEXT NOT NULL,
    channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, section TEXT, topic TEXT, archived INTEGER NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS issues_channel ON issues (channel_id)`,
  `CREATE TABLE IF NOT EXISTS comments (
    comment_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, channel_id TEXT NOT NULL, slack_ts TEXT NOT NULL,
    thread_ts TEXT, root_comment_id TEXT NOT NULL, origin TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS comments_slack ON comments (channel_id, slack_ts)`,
  `CREATE TABLE IF NOT EXISTS names (user_id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS queue (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    not_before INTEGER NOT NULL, created_at INTEGER NOT NULL, last_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dead (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, error TEXT, at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY, name TEXT NOT NULL, status_name TEXT NOT NULL, channel_id TEXT,
    section TEXT, archived INTEGER NOT NULL DEFAULT 0, requested_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS fired (key TEXT PRIMARY KEY, at INTEGER NOT NULL)`,
];

const MAX_ATTEMPTS = 6;
const SEEN_TTL_MS = 3 * 24 * 3600_000;

const toIssue = (r: Row): IssueRecord => ({
  issueId: r.issue_id as string,
  identifier: r.identifier as string,
  title: r.title as string,
  stateName: r.state_name as string,
  channelId: r.channel_id as string,
  channelName: r.channel_name as string,
  section: (r.section as string | null) ?? null,
  topic: (r.topic as string | null) ?? null,
  archived: Number(r.archived) === 1,
});

const toProject = (r: Row): ProjectRecord => ({
  projectId: r.project_id as string,
  name: r.name as string,
  statusName: r.status_name as string,
  channelId: (r.channel_id as string | null) ?? null,
  section: (r.section as string | null) ?? null,
  archived: Number(r.archived) === 1,
  requestedAt:
    r.requested_at === null || r.requested_at === undefined ? null : Number(r.requested_at),
});

const toComment = (r: Row): CommentRecord => ({
  commentId: r.comment_id as string,
  issueId: r.issue_id as string,
  channelId: r.channel_id as string,
  slackTs: r.slack_ts as string,
  threadTs: (r.thread_ts as string | null) ?? null,
  rootCommentId: r.root_comment_id as string,
  origin: r.origin as "linear" | "slack",
});

/**
 * Issue ↔ channel, project ↔ channel and comment ↔ message mappings, plus the durable job queue,
 * whose delayed jobs double as timers.
 */
export class Store {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    for (const statement of MIGRATIONS) sql.exec(statement);
  }

  issue(issueId: string): IssueRecord | null {
    const row = this.#sql.exec(`SELECT * FROM issues WHERE issue_id = ?`, issueId)[0];
    return row ? toIssue(row) : null;
  }

  issueByChannel(channelId: string): IssueRecord | null {
    const row = this.#sql.exec(`SELECT * FROM issues WHERE channel_id = ?`, channelId)[0];
    return row ? toIssue(row) : null;
  }

  allIssues(): IssueRecord[] {
    return this.#sql.exec(`SELECT * FROM issues`).map(toIssue);
  }

  putIssue(r: IssueRecord): void {
    this.#sql.exec(
      `DELETE FROM issues WHERE channel_id = ? AND issue_id != ?`,
      r.channelId,
      r.issueId,
    );
    this.#sql.exec(
      `INSERT INTO issues (issue_id, identifier, title, state_name, channel_id, channel_name, section, topic, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (issue_id) DO UPDATE SET identifier = excluded.identifier, title = excluded.title,
         state_name = excluded.state_name, channel_id = excluded.channel_id, channel_name = excluded.channel_name,
         section = excluded.section, topic = excluded.topic, archived = excluded.archived`,
      r.issueId,
      r.identifier,
      r.title,
      r.stateName,
      r.channelId,
      r.channelName,
      r.section,
      r.topic,
      r.archived ? 1 : 0,
    );
  }

  project(projectId: string): ProjectRecord | null {
    const row = this.#sql.exec(`SELECT * FROM projects WHERE project_id = ?`, projectId)[0];
    return row ? toProject(row) : null;
  }

  allProjects(): ProjectRecord[] {
    return this.#sql.exec(`SELECT * FROM projects`).map(toProject);
  }

  putProject(r: ProjectRecord): void {
    this.#sql.exec(
      `INSERT INTO projects (project_id, name, status_name, channel_id, section, archived, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET name = excluded.name, status_name = excluded.status_name,
         channel_id = excluded.channel_id, section = excluded.section, archived = excluded.archived,
         requested_at = excluded.requested_at`,
      r.projectId,
      r.name,
      r.statusName,
      r.channelId,
      r.section,
      r.archived ? 1 : 0,
      r.requestedAt,
    );
  }

  comment(commentId: string): CommentRecord | null {
    const row = this.#sql.exec(`SELECT * FROM comments WHERE comment_id = ?`, commentId)[0];
    return row ? toComment(row) : null;
  }

  commentBySlack(channelId: string, slackTs: string): CommentRecord | null {
    const row = this.#sql.exec(
      `SELECT * FROM comments WHERE channel_id = ? AND slack_ts = ?`,
      channelId,
      slackTs,
    )[0];
    return row ? toComment(row) : null;
  }

  putComment(c: CommentRecord): void {
    this.#sql.exec(
      `INSERT OR REPLACE INTO comments (comment_id, issue_id, channel_id, slack_ts, thread_ts, root_comment_id, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      c.commentId,
      c.issueId,
      c.channelId,
      c.slackTs,
      c.threadTs,
      c.rootCommentId,
      c.origin,
    );
  }

  deleteComment(commentId: string): void {
    this.#sql.exec(`DELETE FROM comments WHERE comment_id = ?`, commentId);
  }

  name(userId: string): string | null {
    return (
      (this.#sql.exec(`SELECT name FROM names WHERE user_id = ?`, userId)[0]?.name as string) ??
      null
    );
  }

  putName(userId: string, name: string): void {
    this.#sql.exec(`INSERT OR REPLACE INTO names (user_id, name) VALUES (?, ?)`, userId, name);
  }

  /**
   * Queues a job unless one with the same ID was already queued recently. True when queued. It runs
   * at `notBefore`, which defaults to now.
   */
  enqueue(id: string, kind: string, payload: unknown, now: number, notBefore = now): boolean {
    this.#sql.exec(`DELETE FROM seen WHERE at < ?`, now - SEEN_TTL_MS);
    if (this.#sql.exec(`SELECT id FROM seen WHERE id = ?`, id).length) return false;
    this.#sql.exec(`INSERT INTO seen (id, at) VALUES (?, ?)`, id, now);
    this.#sql.exec(
      `INSERT INTO queue (id, kind, payload, not_before, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      kind,
      JSON.stringify(payload),
      notBefore,
      now,
    );
    return true;
  }

  /**
   * Sets when `key` goes off: one job of `kind`, run at `at` in place of any other time set for
   * `key`. Null clears it. Its job ID is `key@at`, so setting the same time again changes nothing,
   * however long ago it was set (unlike `enqueue`, whose dedupe lasts three days).
   */
  setTimer(key: string, kind: string, payload: unknown, at: number | null, now: number): void {
    const prefix = `${key}@`;
    const id = at === null ? null : `${prefix}${at}`;
    this.#sql.exec(
      `DELETE FROM queue WHERE substr(id, 1, ?) = ? AND id IS NOT ?`,
      prefix.length,
      prefix,
      id,
    );
    if (id === null) return;
    this.#sql.exec(
      `INSERT OR IGNORE INTO queue (id, kind, payload, not_before, created_at) VALUES (?, ?, ?, ?, ?)`,
      id,
      kind,
      JSON.stringify(payload),
      at,
      now,
    );
  }

  /** When `key` goes off next (ms), or null when it isn't set. */
  timer(key: string): number | null {
    const prefix = `${key}@`;
    const row = this.#sql.exec(
      `SELECT MIN(not_before) AS t FROM queue WHERE substr(id, 1, ?) = ?`,
      prefix.length,
      prefix,
    )[0];
    return row?.t === null || row?.t === undefined ? null : Number(row.t);
  }

  /** Whether something that should happen once, such as an issue's due notice, already has. */
  fired(key: string): boolean {
    return this.#sql.exec(`SELECT key FROM fired WHERE key = ?`, key).length > 0;
  }

  markFired(key: string, now: number): void {
    this.#sql.exec(`INSERT OR IGNORE INTO fired (key, at) VALUES (?, ?)`, key, now);
  }

  dueJobs(now: number, limit: number): Job[] {
    return this.#sql
      .exec(
        `SELECT id, kind, payload, attempts FROM queue WHERE not_before <= ? ORDER BY created_at, id LIMIT ?`,
        now,
        limit,
      )
      .map((r) => ({
        id: r.id as string,
        kind: r.kind as string,
        payload: r.payload as string,
        attempts: Number(r.attempts),
      }));
  }

  finish(id: string): void {
    this.#sql.exec(`DELETE FROM queue WHERE id = ?`, id);
  }

  /** Records a failure; retries with backoff, and gives up into `dead` after six attempts. */
  fail(job: Job, error: string, now: number): void {
    const attempts = job.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      this.#sql.exec(`DELETE FROM queue WHERE id = ?`, job.id);
      this.#sql.exec(
        `INSERT OR REPLACE INTO dead (id, kind, payload, error, at) VALUES (?, ?, ?, ?, ?)`,
        job.id,
        job.kind,
        job.payload,
        error,
        now,
      );
      return;
    }
    this.#sql.exec(
      `UPDATE queue SET attempts = ?, last_error = ?, not_before = ? WHERE id = ?`,
      attempts,
      error,
      now + 30_000 * 2 ** (attempts - 1),
      job.id,
    );
  }

  /** When the next queued job is due, or null when the queue is empty. */
  nextDue(): number | null {
    const row = this.#sql.exec(`SELECT MIN(not_before) AS t FROM queue`)[0];
    return row?.t === null || row?.t === undefined ? null : Number(row.t);
  }

  stats(): {
    queued: number;
    jobs: { id: string; kind: string; attempts: number; notBefore: number; error: string | null }[];
    dead: { id: string; kind: string; error: string | null; at: number }[];
  } {
    const jobs = this.#sql
      .exec(
        `SELECT id, kind, attempts, not_before, last_error FROM queue ORDER BY created_at LIMIT 20`,
      )
      .map((r) => ({
        id: r.id as string,
        kind: r.kind as string,
        attempts: Number(r.attempts),
        notBefore: Number(r.not_before),
        error: (r.last_error as string | null) ?? null,
      }));
    const queued = Number(this.#sql.exec(`SELECT COUNT(*) AS n FROM queue`)[0]?.n ?? 0);
    const dead = this.#sql
      .exec(`SELECT id, kind, error, at FROM dead ORDER BY at DESC LIMIT 20`)
      .map((r) => ({
        id: r.id as string,
        kind: r.kind as string,
        error: r.error as string | null,
        at: Number(r.at),
      }));
    return { queued, jobs, dead };
  }
}
