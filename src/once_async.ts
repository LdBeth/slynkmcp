/**
 * Single-flight async initializer.
 *
 * - First caller triggers `init()`; concurrent callers await the same promise.
 * - On success the resolved value is memoized — subsequent `run()` calls return
 *   it without re-running `init()`.
 * - On failure nothing is memoized, so the next `run()` call retries.
 * - `reset()` forgets the memoized value and lets the next call re-run `init()`.
 */
export class OnceAsync<T = void> {
  #inFlight: Promise<T> | null = null;
  #result: { value: T } | null = null;
  // Bumped by `reset()` so that an init() resolving after reset can't write
  // its stale value into #result or clear a freshly-started #inFlight.
  #gen = 0;

  get done(): boolean {
    return this.#result !== null;
  }

  run(init: () => Promise<T>): Promise<T> {
    if (this.#result) return Promise.resolve(this.#result.value);
    if (this.#inFlight) return this.#inFlight;
    const gen = this.#gen;
    const p = (async () => {
      try {
        const v = await init();
        if (this.#gen === gen) this.#result = { value: v };
        return v;
      } finally {
        if (this.#gen === gen) this.#inFlight = null;
      }
    })();
    this.#inFlight = p;
    return p;
  }

  reset(): void {
    this.#gen++;
    this.#result = null;
    this.#inFlight = null;
  }
}
