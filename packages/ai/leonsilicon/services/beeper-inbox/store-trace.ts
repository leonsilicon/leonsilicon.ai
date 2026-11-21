import type { MatrixStore } from "#types";

/** What one operation did to Pickle's store, by kind of key. */
export interface StoreTrace {
  ops: Map<string, { count: number; bytes: number; ms: number }>;
}

/** A store key with its IDs replaced, e.g. `crypto/megolm_inbound/:id`. */
export function keyKind(key: string): string {
  return key
    .split(/(?<=[/:|])/)
    .slice(0, 4)
    .map((part) => (/^[!$@+]/.test(part) || part.length > 28 ? ":id" : part))
    .join("");
}

/**
 * Pickle's store with its calls counted while a trace is open, so a slow read can say whether its time
 * went into storage. It changes nothing about what is stored.
 */
export class TracedStore implements MatrixStore {
  readonly #inner: MatrixStore;
  readonly #traces = new Set<StoreTrace>();

  constructor(inner: MatrixStore) {
    this.#inner = inner;
  }

  begin(): StoreTrace {
    const trace: StoreTrace = { ops: new Map() };
    this.#traces.add(trace);
    return trace;
  }

  end(trace: StoreTrace): void {
    this.#traces.delete(trace);
  }

  async delete(key: string): Promise<void> {
    const started = performance.now();
    await this.#inner.delete(key);
    this.#note("delete", key, 0, started);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const started = performance.now();
    const value = await this.#inner.get(key);
    this.#note("get", key, value?.byteLength ?? 0, started);
    return value;
  }

  async list(prefix: string): Promise<string[]> {
    const started = performance.now();
    const keys = await this.#inner.list(prefix);
    this.#note("list", prefix, keys.length, started);
    return keys;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    const started = performance.now();
    await this.#inner.set(key, value);
    this.#note("set", key, value.byteLength, started);
  }

  #note(op: string, key: string, bytes: number, started: number): void {
    if (!this.#traces.size) return;
    const kind = `${op} ${keyKind(key)}`;
    const ms = performance.now() - started;
    for (const trace of this.#traces) {
      const entry = trace.ops.get(kind) ?? { count: 0, bytes: 0, ms: 0 };
      entry.count += 1;
      entry.bytes += bytes;
      entry.ms += ms;
      trace.ops.set(kind, entry);
    }
  }
}
