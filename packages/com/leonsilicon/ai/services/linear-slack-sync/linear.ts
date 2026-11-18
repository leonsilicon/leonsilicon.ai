export interface LinearState {
  id: string;
  name: string;
  type: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  description: string | null;
  state: LinearState;
  teamKey: string;
}

export interface LinearComment {
  id: string;
  body: string;
  issueId: string;
  parentId: string | null;
  authorName: string;
  authorAvatar: string | null;
}

/** What the sync needs from Linear; `LinearClient` talks to the real API, tests use a fake. */
export interface LinearApi {
  issue(id: string): Promise<LinearIssue | null>;
  comment(id: string): Promise<LinearComment | null>;
  openIssues(teamKey: string, closedTypes: string[]): Promise<LinearIssue[]>;
  states(teamKey: string): Promise<LinearState[]>;
  createComment(input: {
    id: string;
    issueId: string;
    body: string;
    parentId?: string;
  }): Promise<void>;
  updateComment(id: string, body: string): Promise<void>;
  updateIssue(id: string, input: { stateId?: string; title?: string }): Promise<void>;
}

export class LinearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearError";
  }
}

const ISSUE_FIELDS = `id identifier number title url description state { id name type } team { key }`;

interface IssueNode {
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  description: string | null;
  state: LinearState;
  team: { key: string };
}

const toIssue = (node: IssueNode): LinearIssue => ({
  id: node.id,
  identifier: node.identifier,
  number: node.number,
  title: node.title,
  url: node.url,
  description: node.description,
  state: node.state,
  teamKey: node.team.key,
});

/** Linear's GraphQL API with a personal API key, which goes in `Authorization` without "Bearer". */
export class LinearClient implements LinearApi {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(apiKey: string, fetchImpl: typeof fetch = fetch) {
    this.#apiKey = apiKey;
    // Called as a plain function: Workers reject `fetch` invoked with another object as `this`.
    this.#fetch = (input, init) => fetchImpl(input, init);
  }

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.#fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.#apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await response.json().catch(() => ({}))) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (json.errors?.length) throw new LinearError(json.errors.map((e) => e.message).join("; "));
    if (!response.ok || !json.data) throw new LinearError(`HTTP ${response.status}`);
    return json.data;
  }

  async issue(id: string) {
    const data = await this.gql<{ issue: IssueNode | null }>(
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id },
    ).catch((error: unknown) => {
      if (error instanceof LinearError && /not found|Entity not found/i.test(error.message))
        return { issue: null };
      throw error;
    });
    return data.issue ? toIssue(data.issue) : null;
  }

  async comment(id: string) {
    const data = await this.gql<{
      comment: {
        id: string;
        body: string;
        issueId: string | null;
        parentId: string | null;
        user: { name: string; displayName: string; avatarUrl: string | null } | null;
        botActor: {
          name: string | null;
          userDisplayName: string | null;
          avatarUrl: string | null;
        } | null;
        externalUser: { name: string; avatarUrl: string | null } | null;
      } | null;
    }>(
      `query($id: String!) { comment(id: $id) { id body issueId parentId
        user { name displayName avatarUrl }
        botActor { name userDisplayName avatarUrl }
        externalUser { name avatarUrl } } }`,
      { id },
    );
    const c = data.comment;
    if (!c?.issueId) return null;
    const bot = c.botActor;
    const authorName =
      (bot && (bot.userDisplayName ? `${bot.userDisplayName} (via ${bot.name})` : bot.name)) ||
      c.user?.name ||
      c.externalUser?.name ||
      "Linear";
    return {
      id: c.id,
      body: c.body,
      issueId: c.issueId,
      parentId: c.parentId,
      authorName,
      authorAvatar: bot?.avatarUrl ?? c.user?.avatarUrl ?? c.externalUser?.avatarUrl ?? null,
    };
  }

  async openIssues(teamKey: string, closedTypes: string[]) {
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    do {
      const data: {
        issues: {
          nodes: IssueNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } = await this.gql(
        `query($team: String!, $closed: [String!], $after: String) {
          issues(first: 100, after: $after, filter: { team: { key: { eq: $team } }, state: { type: { nin: $closed } } }) {
            nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        { team: teamKey, closed: closedTypes, after },
      );
      issues.push(...data.issues.nodes.map(toIssue));
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    } while (after);
    return issues;
  }

  async states(teamKey: string) {
    const data = await this.gql<{ workflowStates: { nodes: LinearState[] } }>(
      `query($team: String!) { workflowStates(first: 100, filter: { team: { key: { eq: $team } } }) { nodes { id name type } } }`,
      { team: teamKey },
    );
    return data.workflowStates.nodes;
  }

  async createComment(input: { id: string; issueId: string; body: string; parentId?: string }) {
    const data = await this.gql<{ commentCreate: { success: boolean } }>(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input },
    );
    if (!data.commentCreate.success) throw new LinearError("commentCreate failed");
  }

  async updateComment(id: string, body: string) {
    await this.gql(
      `mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success } }`,
      { id, body },
    );
  }

  async updateIssue(id: string, input: { stateId?: string; title?: string }) {
    await this.gql(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id, input },
    );
  }
}
