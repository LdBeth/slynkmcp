/**
 * Single-flight async initializer.
 *
 * - First caller triggers `init()`; concurrent callers await the same promise.
 * - On success the result is memoized — subsequent `run()` calls are no-ops.
 * - On failure nothing is memoized, so the next `run()` call retries.
 * - `reset()` forgets the success and lets the next call re-run `init()`.
 */
export class OnceAsync {
  #inFlight: Promise<void> | null = null;
  #done = false;

  get done(): boolean {
    return this.#done;
  }

  run(init: () => Promise<void>): Promise<void> {
    if (this.#done) return Promise.resolve();
    if (this.#inFlight) return this.#inFlight;
    const p = (async () => {
      try {
        await init();
        this.#done = true;
      } finally {
        this.#inFlight = null;
      }
    })();
    this.#inFlight = p;
    return p;
  }

  reset(): void {
    this.#done = false;
    this.#inFlight = null;
  }
}
