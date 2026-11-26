/**
 * One run of an expensive refresh at a time, shared by everyone who asks while it runs.
 *
 * - `get()` (the default) is for a caller that needs what the server has now, like a room it can't
 *   find yet: it gets a run that started after it asked. Requests that arrive while one runs share a
 *   single next run.
 * - `get(maxAgeMs)` is for periodic checks: the last result is reused while its run started less
 *   than `maxAgeMs` ago, and a run in progress is joined.
 *
 * The room directory needs this: its refresh is a full `/sync` of every room (12-20 s, more when
 * Matrix is slow). With a plain queue each request ran one of its own, and the Slack feeds, the Grok
 * relay and the Linear publisher (each asking about once a minute) kept one running back to back,
 * about 150 an hour, with any tool call that needed a refresh waiting behind all of them.
 */
export class Coalesced<T> {
  readonly #run: () => Promise<T>;
  readonly #now: () => number;
  #running: { promise: Promise<T>; startedAt: number } | null = null;
  #next: Promise<T> | null = null;
  #last: { value: T; startedAt: number } | null = null;

  constructor(run: () => Promise<T>, now: () => number = Date.now) {
    this.#run = run;
    this.#now = now;
  }

  get(maxAgeMs = 0): Promise<T> {
    const asked = this.#now();
    if (maxAgeMs > 0) {
      if (this.#last && asked - this.#last.startedAt < maxAgeMs)
        return Promise.resolve(this.#last.value);
      if (this.#running) return this.#running.promise;
    }
    if (!this.#running) return this.#start();
    if (this.#running.startedAt >= asked) return this.#running.promise;
    const after = this.#running.promise.then(
      () => undefined,
      () => undefined,
    );
    this.#next ??= after.then(() => {
      this.#next = null;
      // Someone may have started one in the moment between the two runs.
      return this.#running && this.#running.startedAt >= asked
        ? this.#running.promise
        : this.#start();
    });
    return this.#next;
  }

  /** Forgets the last result (the store it described was closed). */
  reset(): void {
    this.#last = null;
  }

  #start(): Promise<T> {
    const startedAt = this.#now();
    const promise: Promise<T> = (async () => this.#run())()
      .then((value) => {
        this.#last = { value, startedAt };
        return value;
      })
      .finally(() => {
        if (this.#running?.promise === promise) this.#running = null;
      });
    this.#running = { promise, startedAt };
    return promise;
  }
}
