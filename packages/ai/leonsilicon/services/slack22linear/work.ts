/** Authoritative Slack work reported by the Hermes gateway and its local runners. */
export interface WorkSnapshot {
  /** Gateway sample time in Unix microseconds. */
  at: number;
  active: string[];
  /** A turn also reports its finish if it was too short to appear in an active snapshot. */
  finished: string[];
  /** Work that may continue on a runner without a status feed. */
  unobserved: string[];
}

export interface WorkEnded {
  channel: string;
  at: number;
}

const channelId = /^[CG][A-Z0-9]{1,30}$/;

export function readWorkSnapshot(input: unknown): WorkSnapshot | null {
  const snapshot = input as Partial<WorkSnapshot> | null;
  if (
    !snapshot ||
    typeof snapshot.at !== "number" ||
    !Number.isSafeInteger(snapshot.at) ||
    snapshot.at <= 0
  )
    return null;
  for (const channels of [snapshot.active, snapshot.finished, snapshot.unobserved]) {
    if (
      !Array.isArray(channels) ||
      channels.length > 500 ||
      !channels.every((channel) => typeof channel === "string" && channelId.test(channel))
    )
      return null;
  }
  return snapshot as WorkSnapshot;
}
