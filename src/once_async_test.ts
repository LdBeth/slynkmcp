import { assertEquals, assertRejects } from "@std/assert";
import { OnceAsync } from "./once_async.ts";

Deno.test("OnceAsync: runs init exactly once on success", async () => {
  const gate = new OnceAsync();
  let calls = 0;
  const init = () => {
    calls++;
    return Promise.resolve();
  };
  await gate.run(init);
  await gate.run(init);
  await gate.run(init);
  assertEquals(calls, 1);
  assertEquals(gate.done, true);
});

Deno.test("OnceAsync: concurrent callers share a single in-flight init", async () => {
  const gate = new OnceAsync();
  let calls = 0;
  let resolveInit!: () => void;
  const init = () => {
    calls++;
    return new Promise<void>((r) => {
      resolveInit = r;
    });
  };
  const a = gate.run(init);
  const b = gate.run(init);
  const c = gate.run(init);
  assertEquals(calls, 1);
  resolveInit();
  await Promise.all([a, b, c]);
  assertEquals(calls, 1);
  assertEquals(gate.done, true);
});

Deno.test("OnceAsync: failure is not memoized — next call retries", async () => {
  const gate = new OnceAsync();
  let calls = 0;
  const init = () => {
    calls++;
    if (calls === 1) return Promise.reject(new Error("boom"));
    return Promise.resolve();
  };
  await assertRejects(() => gate.run(init), Error, "boom");
  assertEquals(gate.done, false);
  await gate.run(init);
  assertEquals(calls, 2);
  assertEquals(gate.done, true);
});

Deno.test("OnceAsync: concurrent callers all reject when init fails", async () => {
  const gate = new OnceAsync();
  let rejectInit!: (e: Error) => void;
  const init = () =>
    new Promise<void>((_, reject) => {
      rejectInit = reject;
    });
  const a = gate.run(init);
  const b = gate.run(init);
  rejectInit(new Error("nope"));
  await assertRejects(() => a, Error, "nope");
  await assertRejects(() => b, Error, "nope");
  assertEquals(gate.done, false);
});

Deno.test("OnceAsync<T>: run() returns init's resolved value, memoized across calls", async () => {
  const gate = new OnceAsync<{ pid: number }>();
  let calls = 0;
  const init = () => {
    calls++;
    return Promise.resolve({ pid: 42 });
  };
  const a = await gate.run(init);
  const b = await gate.run(init);
  assertEquals(a, { pid: 42 });
  assertEquals(b, { pid: 42 });
  assertEquals(a, b);
  assertEquals(calls, 1);
});

Deno.test("OnceAsync: reset() lets init run again", async () => {
  const gate = new OnceAsync();
  let calls = 0;
  const init = () => {
    calls++;
    return Promise.resolve();
  };
  await gate.run(init);
  assertEquals(calls, 1);
  gate.reset();
  assertEquals(gate.done, false);
  await gate.run(init);
  assertEquals(calls, 2);
});

Deno.test("OnceAsync: reset() during in-flight init discards the stale value", async () => {
  const gate = new OnceAsync<number>();
  let resolveFirst!: (v: number) => void;
  let resolveSecond!: (v: number) => void;
  let calls = 0;
  const init = () => {
    calls++;
    return new Promise<number>((r) => {
      if (calls === 1) resolveFirst = r;
      else resolveSecond = r;
    });
  };
  // First call starts init #1 (will resolve with 1, but to a now-dead generation).
  const first = gate.run(init);
  gate.reset();
  // Second call starts a fresh init #2 (will resolve with 2).
  const second = gate.run(init);
  resolveFirst(1);
  resolveSecond(2);
  assertEquals(await first, 1); // original caller still gets what it awaited
  assertEquals(await second, 2);
  // Third call must see the live value (2), not the stale memoized one.
  const third = await gate.run(init);
  assertEquals(third, 2);
  assertEquals(calls, 2);
});
