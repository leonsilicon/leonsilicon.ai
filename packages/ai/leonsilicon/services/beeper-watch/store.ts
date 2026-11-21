import fs from "node:fs";
import path from "node:path";
import type { Logger, Watch } from "#types";

/** Watches persisted as one JSON file, written atomically after every change. */
export class WatchStore {
  #file: string;
  #watches = new Map<string, Watch>();

  constructor(file: string, log: Logger) {
    this.#file = file;
    for (const watch of load(file, log)) this.#watches.set(watch.id, watch);
  }

  list(): Watch[] {
    return [...this.#watches.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): Watch | undefined {
    return this.#watches.get(id);
  }

  put(watch: Watch): void {
    this.#watches.set(watch.id, watch);
    this.save();
  }

  delete(id: string): boolean {
    const had = this.#watches.delete(id);
    if (had) this.save();
    return had;
  }

  save(): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ version: 1, watches: this.list() }, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
    fs.renameSync(temporary, this.#file);
  }
}

function load(file: string, log: Logger): Watch[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const data = JSON.parse(raw) as { watches?: unknown };
    if (Array.isArray(data.watches)) return data.watches as Watch[];
    throw new Error("missing watches array");
  } catch (error) {
    // Keep the unreadable file for inspection instead of crash-looping under launchd.
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    log("error", "watch store was unreadable; starting empty", {
      movedTo: aside,
      error: (error as Error).message,
    });
    return [];
  }
}
