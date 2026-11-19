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
  /** Linear's own due date, `YYYY-MM-DD`: a day with no time. */
  dueDate: string | null;
}

export interface LinearComment {
  id: string;
  body: string;
  issueId: string;
  parentId: string | null;
  authorName: string;
  authorAvatar: string | null;
}

export interface LinearProject {
  id: string;
  name: string;
  url: string;
  status: { name: string; type: string };
  /** The Slack channel Linear's own Slack app has connected to the project, if any. */
  slackChannelId: string | null;
  teamKeys: string[];
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Archived or deleted (in the trash). */
  gone: boolean;
}

/** The workspace's "Project channels" setting (Linear → Settings → Integrations → Slack). */
export interface ProjectChannelSettings {
  /** The Slack integration whose bot creates project channels. */
  integrationId: string;
  /** Channel name prefix chosen in that setting: `p-`, `proj-` or `project-`. */
  prefix: string;
}

/** What the sync needs from Linear; `LinearClient` talks to the real API, tests use a fake. */
export interface LinearApi {
  issue(id: string): Promise<LinearIssue | null>;
  comment(id: string): Promise<LinearComment | null>;
  openIssues(teamKey: string, closedTypes: string[]): Promise<LinearIssue[]>;
  project(id: string): Promise<LinearProject | null>;
  openProjects(teamKey: string, closedTypes: string[]): Promise<LinearProject[]>;
  /** Null when project channels are off, or no Slack workspace is connected. */
  projectChannelSettings(): Promise<ProjectChannelSettings | null>;
  /**
   * Has Linear's Slack app create a public channel and connect it to the project, as the project's
   * "Create Slack channel…" action does. Linear does it in the background, within seconds.
   */
  createProjectChannel(input: {
    projectId: string;
    name: string;
    integrationId: string;
  }): Promise<void>;
  states(teamKey: string): Promise<LinearState[]>;
  createComment(input: {
    id: string;
    issueId: string;
    body: string;
    parentId?: string;
  }): Promise<void>;
  updateComment(id: string, body: string): Promise<void>;
  updateIssue(id: string, input: IssueUpdate): Promise<void>;
}

/** The issue fields the sync changes. `dueDate` is `YYYY-MM-DD`, or null to clear it. */
export interface IssueUpdate {
  stateId?: string;
  title?: string;
  dueDate?: string | null;
}

export class LinearError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearError";
  }
}

const ISSUE_FIELDS = `id identifier number title url description dueDate state { id name type } team { key }`;

interface IssueNode {
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  description: string | null;
  dueDate: string | null;
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
  dueDate: node.dueDate ?? null,
});

const PROJECT_FIELDS = `id name url createdAt archivedAt trashed status { name type } slackChannelId
  teams { nodes { key } }`;

interface ProjectNode {
  id: string;
  name: string;
  url: string;
  createdAt: string;
  archivedAt: string | null;
  trashed: boolean | null;
  status: { name: string; type: string };
  slackChannelId: string | null;
  teams: { nodes: { key: string }[] };
}

const toProject = (node: ProjectNode): LinearProject => ({
  id: node.id,
  name: node.name,
  url: node.url,
  status: node.status,
  slackChannelId: node.slackChannelId || null,
  teamKeys: node.teams.nodes.map((t) => t.key),
  createdAt: Date.parse(node.createdAt),
  gone: Boolean(node.archivedAt || node.trashed),
});

const notFound = (error: unknown) =>
  error instanceof LinearError && /not found|Entity not found/i.test(error.message);

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
      if (notFound(error)) return { issue: null };
      throw error;
    });
    return data.issue ? toIssue(data.issue) : null;
  }

  async project(id: string) {
    const data = await this.gql<{ project: ProjectNode | null }>(
      `query($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`,
      { id },
    ).catch((error: unknown) => {
      if (notFound(error)) return { project: null };
      throw error;
    });
    return data.project ? toProject(data.project) : null;
  }

  async openProjects(teamKey: string, closedTypes: string[]) {
    const projects: LinearProject[] = [];
    let after: string | null = null;
    do {
      const data: {
        projects: {
          nodes: ProjectNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } = await this.gql(
        `query($team: String!, $closed: [String!], $after: String) {
          projects(first: 100, after: $after, filter: {
            accessibleTeams: { some: { key: { eq: $team } } }, status: { type: { nin: $closed } } }) {
            nodes { ${PROJECT_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
        { team: teamKey, closed: closedTypes, after },
      );
      projects.push(...data.projects.nodes.map(toProject));
      after = data.projects.pageInfo.hasNextPage ? data.projects.pageInfo.endCursor : null;
    } while (after);
    return projects;
  }

  async projectChannelSettings() {
    const data = await this.gql<{
      organization: {
        slackProjectChannelIntegration: { id: string } | null;
        slackProjectChannelPrefix: string | null;
      };
    }>(`{ organization { slackProjectChannelIntegration { id } slackProjectChannelPrefix } }`);
    const { slackProjectChannelIntegration: integration, slackProjectChannelPrefix: prefix } =
      data.organization;
    return integration ? { integrationId: integration.id, prefix: prefix || "project-" } : null;
  }

  // Not in Linear's published schema: it is the mutation behind the project's "Create Slack
  // channel…" action in Linear's own app, and it accepts a personal API key.
  async createProjectChannel(input: { projectId: string; name: string; integrationId: string }) {
    const data = await this.gql<{ projectCreateSlackChannel: { success: boolean } }>(
      `mutation($id: String!, $name: String!, $integrationId: String) {
        projectCreateSlackChannel(id: $id, slackChannelName: $name, integrationId: $integrationId) { success } }`,
      { id: input.projectId, name: input.name, integrationId: input.integrationId },
    );
    if (!data.projectCreateSlackChannel.success)
      throw new LinearError("projectCreateSlackChannel failed");
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

  async updateIssue(id: string, input: IssueUpdate) {
    await this.gql(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id, input },
    );
  }
}
