import { issueWorkflow, parseTitle } from "#format";
import type { LinearIssue } from "#linear";
import type { IssueRecord, Sql } from "#store";

export interface MatrixIssueMetadata {
  version: 1;
  identifier: string;
  channelId: string;
  title: string;
  statusName: string;
  statusType: string;
  statusColor: string | null;
  priority: number;
  url: string;
  dueDate: string | null;
  meta: Record<string, string>;
}

export interface DeletedMatrixIssue {
  version: 1;
  identifier: string;
  channelId: string;
  deleted: true;
}

export type MatrixIssueRecord = MatrixIssueMetadata | DeletedMatrixIssue;

/** The publisher reads the latest data, keyed by Slack channel so a backfill is restartable. */
export class IssueMetadata {
  readonly #sql: Sql;

  constructor(sql: Sql) {
    this.#sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS matrix_issue_metadata (
      channel_id TEXT PRIMARY KEY, data TEXT NOT NULL
    )`);
  }

  save(channelId: string, issue: LinearIssue): void {
    const { name } = parseTitle(issue.title);
    this.#put({
      version: 1,
      channelId,
      identifier: issue.identifier,
      title: name || "Untitled issue",
      statusName: issue.state.name,
      statusType: issue.state.type,
      statusColor: issue.state.color ?? null,
      priority: issue.priority,
      url: issue.url,
      dueDate: issue.dueDate,
      meta: issueWorkflow(issue),
    });
  }

  remove(record: IssueRecord): void {
    this.#put({
      version: 1,
      channelId: record.channelId,
      identifier: record.identifier,
      deleted: true,
    });
  }

  snapshot(): string {
    const rows = this.#sql.exec(`SELECT data FROM matrix_issue_metadata ORDER BY channel_id`);
    return `[${rows.map(({ data }) => data).join(",")}]`;
  }

  #put(record: MatrixIssueRecord): void {
    this.#sql.exec(
      `INSERT INTO matrix_issue_metadata (channel_id, data) VALUES (?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET data = excluded.data
       WHERE matrix_issue_metadata.data != excluded.data`,
      record.channelId,
      JSON.stringify(record),
    );
  }
}
