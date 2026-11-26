// Pure logic for grok-box-browser, run from Python through PythonMonkey (see __init__.py).

const ISSUE_CHANNEL = /^leon-(\d+)(?:-|$)/;

/**
 * The browser a Hermes turn gets: one per Linear issue, by its AutoLinear channel (`leon-532-…` →
 * `leon-532`), else one per Slack conversation, else one per Hermes task.
 */
export function taskKey(platform: string, chatName: string, chatId: string, taskId: string) {
  const issue = ISSUE_CHANNEL.exec(chatName.trim().toLowerCase());
  if (issue) return `leon-${issue[1]}`;
  const chat = chatId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (platform && chat)
    return `${platform.toLowerCase().replace(/[^a-z0-9]/g, "")}-${chat}`.slice(0, 64);
  const task = taskId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return task ? `hermes-${task}` : "hermes";
}

/** `leon-532` → `LEON-532`, the Linear issue a task browser belongs to. */
export function issueIdentifier(task: string) {
  const match = /^leon-(\d+)$/.exec(task);
  return match ? `LEON-${match[1]}` : null;
}

/** A browser's profile is kept for a week once its issue is done or canceled. */
export function shouldRetire(stateType: string) {
  return stateType === "completed" || stateType === "canceled";
}

/** Session metadata in the shape Hermes's browser tools cache (`agent/browser_provider.py`). */
export function sessionInfo(task: string, localPort: number, ws: string, seeded: number) {
  return {
    session_name: `grok-box-${task}`,
    bb_session_id: task,
    cdp_url: `ws://127.0.0.1:${localPort}${ws}`,
    features: { grok_box: true, task, seeded_cookies: seeded },
  };
}

/** What Hermes is told when the box can't be reached, so it can bring the broker back. */
export function unreachableMessage(detail: string) {
  return (
    "The Grok box browser is unreachable (" +
    detail +
    "). The Grok Bot cloud computer may have restarted. Ask a Grok bot to run " +
    "`bash /workspace/hermes-browsers/box/up.sh` in its own terminal and report the output, then try again."
  );
}
