# Interactive Debugger for `lisp_eval` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lisp_eval` Lisp errors interactive — the model inspects frames and picks restarts — while every other tool keeps auto-aborting on debugger entry.

**Architecture:** `SlynkClient` tags the one in-flight interactive request and marks the `:debug` event it produces. `Session.onDebugActivate` auto-aborts only non-interactive debuggers; for an interactive one, `Session.eval` returns early leaving the rex parked, and `debugInvokeRestart` / `debugAbort` resume that parked rex and report its outcome.

**Tech Stack:** Deno + TypeScript, `@std/assert` for tests. Slynk wire protocol over TCP. Integration tests run against a live SBCL Slynk.

**Spec:** `docs/superpowers/specs/2026-05-18-interactive-debugger-design.md`

---

## Prerequisites for integration tests

Tasks 1–3 add tests to `src/integration_test.ts`. Those tests are gated on the
`SLYNK_TEST_PORT` env var (skipped when unset, so plain `deno test` and CI stay
green). To run them you need a live SBCL Slynk on port 4006.

**Start the test Slynk** (leave it running for the whole session):

```bash
sbcl --non-interactive --load scripts/start-test-slynk.lisp >/tmp/swankmcp-test-slynk.log 2>&1 &
# wait until ready:
until grep -q "SLYNK-TEST READY" /tmp/swankmcp-test-slynk.log 2>/dev/null; do sleep 1; done
```

**Stop it** when finished:

```bash
pkill -f start-test-slynk.lisp
```

The `scripts/start-test-slynk.lisp` file is created in Task 1, Step 1.

## File Structure

- **Create** `scripts/start-test-slynk.lisp` — boots an SBCL Slynk on :4006 for integration tests.
- **Create** `src/integration_test.ts` — env-gated integration tests spanning `SlynkClient` and `Session`.
- **Create** `src/mcp/tool_helpers_test.ts` — pure unit test for `formatEvalResult`.
- **Modify** `src/slynk/client.ts` — `RexOptions.interactive`, `#interactiveId` tracking, `DebugInfo.interactive`.
- **Modify** `src/session.ts` — selective auto-abort, `eval` early-return, `#suspendedEval`, `#resumeVia`, remove `withCapture`.
- **Modify** `src/mcp/tool_helpers.ts` — `formatEvalResult` handles `debugEntered`.
- **Modify** `src/mcp/tools.ts` — tool description tweaks for `lisp_eval` and `lisp_debug_invoke_restart`.
- **Modify** `CLAUDE.md`, `README.md` — document the interactive-vs-auto-abort split.

---

## Task 1: SlynkClient — tag the interactive request and mark its debugger

**Files:**
- Create: `scripts/start-test-slynk.lisp`
- Create: `src/integration_test.ts`
- Modify: `src/slynk/client.ts` (`RexOptions` ~59-64, `DebugInfo` ~29-40, `rex` ~117-132, `#dispatch` `:return`/`:debug`/`:reader-error` cases, `#readLoop` teardown ~162-168)
- Test: `src/integration_test.ts`

- [ ] **Step 1: Create the test Slynk boot script**

Create `scripts/start-test-slynk.lisp`:

```lisp
;;; Boots an SBCL Slynk listener on port 4006 for swankmcp integration tests.
;;; Run with:  sbcl --non-interactive --load scripts/start-test-slynk.lisp
(load (car (directory #P"~/.emacs.d/elpa/sly-*/slynk/slynk.asd")))
(asdf:load-system :slynk)
(slynk:create-server :port 4006 :dont-close t)
(format t "~&SLYNK-TEST READY~%")
(force-output)
(loop (sleep 60))
```

- [ ] **Step 2: Write the failing test**

Create `src/integration_test.ts`:

```ts
/**
 * Integration tests against a live SBCL Slynk. Gated on SLYNK_TEST_PORT so
 * plain `deno test` and CI skip them. To run:
 *
 *   sbcl --non-interactive --load scripts/start-test-slynk.lisp &
 *   SLYNK_TEST_PORT=4006 deno test --allow-net --allow-env --allow-read \
 *     --allow-write --config deno.json src/integration_test.ts
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SlynkClient } from "./slynk/client.ts";
import { sym } from "./slynk/sexp.ts";

const PORT_ENV = Deno.env.get("SLYNK_TEST_PORT");
const PORT = PORT_ENV ? Number(PORT_ENV) : 0;
const ignore = PORT_ENV === undefined;
const HOST = "127.0.0.1";

Deno.test({
  name: "SlynkClient: interactive flag marks the originating debugger",
  ignore,
  fn: async () => {
    const client = new SlynkClient({ onDebugActivate: () => {} });
    await client.connect(HOST, PORT);
    try {
      await client.rex([sym("slynk:connection-info")]);
      const marked = client.rex(
        [sym("slynk:interactive-eval"), "(/ 1 0)"],
        { pkg: "CL-USER", interactive: true },
      );
      marked.catch(() => {});
      const plain = client.rex(
        [sym("slynk:interactive-eval"), '(error "plain")'],
        { pkg: "CL-USER" },
      );
      plain.catch(() => {});
      for (let i = 0; i < 150 && client.debugStack.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assertEquals(client.debugStack.length, 2);
      assertEquals(client.debugStack.filter((d) => d.interactive).length, 1);
      assertEquals(client.debugStack.filter((d) => !d.interactive).length, 1);
      const interactiveDbg = client.debugStack.find((d) => d.interactive)!;
      assertStringIncludes(interactiveDbg.condition.message, "DIVISION-BY-ZERO");
      // clean up: abort both debug levels
      for (const d of client.debugStack) {
        const idx = d.restarts.findIndex((r) => /^abort$/i.test(r.name));
        client.rex(
          [sym("slynk:invoke-nth-restart-for-emacs"), d.level, idx],
          { thread: d.thread },
        ).catch(() => {});
      }
      await Promise.allSettled([marked, plain]);
      assert(true);
    } finally {
      await client.close();
    }
  },
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `deno test --allow-net --allow-env --config deno.json src/integration_test.ts`
Expected: FAIL — type-check error, `'interactive' does not exist in type 'RexOptions'` and `Property 'interactive' does not exist on type 'DebugInfo'`.

- [ ] **Step 4: Add `interactive` to `RexOptions` and `DebugInfo`**

In `src/slynk/client.ts`, change the `RexOptions` interface (currently ~59-64):

```ts
export interface RexOptions {
  /** Common Lisp package name; defaults to "COMMON-LISP-USER" */
  pkg?: string;
  /** Slynk thread designator; "t" (default), ":repl-thread", or a number */
  thread?: "t" | ":repl-thread" | number;
  /**
   * Mark this request interactive: a debugger it triggers is NOT auto-aborted
   * by the caller. At most one interactive request is in flight at a time.
   */
  interactive?: boolean;
}
```

Add a field to the `DebugInfo` type (currently ~29-40), after `pendingIds`:

```ts
  /** continuation ids that are waiting on this debug level */
  pendingIds: number[];
  /** true when this debugger was triggered by the current interactive request */
  interactive: boolean;
```

- [ ] **Step 5: Track the interactive request id in `SlynkClient`**

In `src/slynk/client.ts`, add a field next to `debugStack` (~79-80):

```ts
  /** Stack of active debug levels (innermost last). */
  debugStack: DebugInfo[] = [];

  /** Id of the in-flight interactive request, or null. Cleared when it settles. */
  #interactiveId: number | null = null;
```

In `rex` (~117-132), record the id when `opts.interactive` is set. After
`const id = this.#nextId++;`:

```ts
    const id = this.#nextId++;
    if (opts.interactive) this.#interactiveId = id;
    const pkg = opts.pkg ?? "COMMON-LISP-USER";
```

- [ ] **Step 6: Compute `interactive` in the `:debug` case and clear the id on settle**

In `#dispatch`, `:debug` case (~204-237), replace the `pendingIds` line of the
`info` object with a precomputed const so it can be reused:

```ts
        const pendingIds = pendingList.map((p) => (typeof p === "number" ? p : 0));
        const info: DebugInfo = {
          thread,
          level,
          condition: {
            message: typeof condList[0] === "string" ? condList[0] : print(condList[0] ?? []),
            type: typeof condList[1] === "string" ? condList[1] : print(condList[1] ?? []),
          },
          restarts: restartList.map((r) => {
            const rl = asList(r, "restart");
            return {
              name: typeof rl[0] === "string" ? rl[0] : print(rl[0] ?? []),
              description: typeof rl[1] === "string" ? rl[1] : print(rl[1] ?? []),
            };
          }),
          frames: frameList.map((f) => {
            const fl = asList(f, "frame");
            return {
              index: typeof fl[0] === "number" ? fl[0] : 0,
              description: typeof fl[1] === "string" ? fl[1] : print(fl[1] ?? []),
            };
          }),
          pendingIds,
          interactive: this.#interactiveId !== null && pendingIds.includes(this.#interactiveId),
        };
        this.debugStack.push(info);
        return;
```

In the `:return` case (~182-202), clear the id when the interactive rex settles.
After `this.#pending.delete(id);`:

```ts
        this.#pending.delete(id);
        if (id === this.#interactiveId) this.#interactiveId = null;
```

In the `:reader-error` case (~283-296), after `this.#pending.delete(maxId);`:

```ts
          this.#pending.delete(maxId);
          if (maxId === this.#interactiveId) this.#interactiveId = null;
```

In `#readLoop` teardown (~162-168), after `this.#pending.clear();`:

```ts
    this.#pending.clear();
    this.#interactiveId = null;
    this.debugStack.length = 0;
```

- [ ] **Step 7: Run the test to verify it passes**

Start the test Slynk (see Prerequisites), then run:

`SLYNK_TEST_PORT=4006 deno test --allow-net --allow-env --allow-read --allow-write --config deno.json src/integration_test.ts`

Expected: PASS — 1 test passed.

- [ ] **Step 8: Verify formatting, lint, and types**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add scripts/start-test-slynk.lisp src/integration_test.ts src/slynk/client.ts
git commit -m "feat: tag interactive Slynk requests and mark their debugger

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Session — selective auto-abort and `eval` early-return

**Files:**
- Modify: `src/session.ts` (`EvalResult` ~53-58, `Session` fields ~60-73, `onDebugActivate` ~94-105, `onDisconnect` ~106-111, `withCapture`/`eval` ~195-223)
- Test: `src/integration_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/integration_test.ts`. First add `Session` to the imports at the
top of the file — change the import block to:

```ts
import { assert, assertEquals, assertExists, assertRejects, assertStringIncludes } from "@std/assert";
import { Session } from "./session.ts";
import { SlynkClient } from "./slynk/client.ts";
import { sym } from "./slynk/sexp.ts";
```

Then add a helper after the `HOST` constant:

```ts
function newSession(): Session {
  return new Session({ host: HOST, port: PORT, defaultPackage: "CL-USER" });
}
```

Then append these tests:

```ts
Deno.test({
  name: "Session.eval: an interactive error suspends in the debugger",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      const r = await session.eval("(/ 1 0)");
      assertEquals(r.debugEntered, true);
      const d = session.currentDebug();
      assertExists(d);
      assertStringIncludes(d.condition.message, "DIVISION-BY-ZERO");
    } finally {
      await session.stop();
    }
  },
});

Deno.test({
  name: "Session: non-eval errors still auto-abort",
  ignore,
  fn: async () => {
    const session = newSession();
    const file = await Deno.makeTempFile({ suffix: ".lisp" });
    await Deno.writeTextFile(file, '(error "load-time boom")\n');
    try {
      await assertRejects(() => session.loadFile(file));
      assertEquals(session.currentDebug(), null);
    } finally {
      await session.stop();
      await Deno.remove(file);
    }
  },
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `deno test --allow-net --allow-env --config deno.json src/integration_test.ts`
Expected: FAIL — type-check error, `Property 'debugEntered' does not exist on type 'EvalResult'`.

- [ ] **Step 3: Add `debugEntered` to `EvalResult`**

In `src/session.ts`, change the `EvalResult` interface (~53-58):

```ts
export interface EvalResult {
  /** Printed result (the value Lisp returned, as a string). */
  value: string;
  /** Captured stdout / mREPL output during the call. */
  output: string;
  /** True when the evaluation suspended in the debugger instead of returning. */
  debugEntered?: boolean;
}
```

- [ ] **Step 4: Add the `Deferred` helper and the new Session fields**

In `src/session.ts`, add this helper at the end of the file, after
`parseConnectionInfo`:

```ts
interface Deferred {
  promise: Promise<void>;
  fire: () => void;
}

/** A one-shot promise whose resolution is triggered externally. */
function deferred(): Deferred {
  let fire!: () => void;
  const promise = new Promise<void>((res) => {
    fire = res;
  });
  return { promise, fire };
}
```

Add two fields to the `Session` class, next to `#captureBuf` (~70-73):

```ts
  /** Currently-capturing output buffer (set while a tool call is in flight). */
  #captureBuf: string[] | null = null;
  /** Mutex queue for output-capturing calls. */
  #queue: Promise<unknown> = Promise.resolve();
  /** A parked interactive eval whose rex is suspended in the debugger. */
  #suspendedEval: { rexPromise: Promise<Sexp>; buf: string[] } | null = null;
  /** Set while eval / a resume is waiting for an interactive debugger to open. */
  #debugEntered: Deferred | null = null;
```

- [ ] **Step 5: Make `onDebugActivate` selective and clear state on disconnect**

In `src/session.ts`, replace the `onDebugActivate` handler (~94-105):

```ts
      onDebugActivate: (info) => {
        if (info.interactive) {
          // lisp_eval's debugger: leave it open for the model to drive;
          // just wake whoever is waiting for the suspend signal.
          this.#debugEntered?.fire();
          return;
        }
        // Auto-abort policy for every non-interactive tool: invoke the first
        // ABORT-ish restart so the rex returns instead of wedging.
        const abortIdx = info.restarts.findIndex((r) => /^abort$/i.test(r.name));
        const idx = abortIdx >= 0 ? abortIdx : info.restarts.length - 1;
        if (idx >= 0) {
          this.#client.rex(
            [sym("slynk:invoke-nth-restart-for-emacs"), info.level, idx],
            { thread: info.thread },
          ).catch(() => {});
        }
      },
```

Replace the `onDisconnect` handler (~106-111):

```ts
      onDisconnect: () => {
        // Drop cached per-connection state; next tool call rebuilds via ensureConnected().
        this.mreplChannelId = null;
        this.mreplRemoteId = null;
        this.#connectGate.reset();
        this.#suspendedEval = null;
        this.#captureBuf = null;
        this.#debugEntered = null;
      },
```

- [ ] **Step 6: Replace `withCapture` and `eval` with the early-return version**

In `src/session.ts`, delete the `withCapture` method (~195-210) and replace the
`eval` method (~212-223) with:

```ts
  /**
   * Eval a string in the session's default package, capturing stdout.
   *
   * If the evaluation drops into the Slynk debugger, this resolves early with
   * `debugEntered: true` and parks the rex; the `lisp_debug_*` tools then drive
   * it. Calls are serialized so capture buffers never interleave.
   */
  async eval(code: string, pkg?: string): Promise<EvalResult> {
    await this.#ensureConnected();
    const p = pkg ?? this.defaultPackage;
    const run = () => this.#evalOnce(code, p);
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #evalOnce(code: string, pkg: string): Promise<EvalResult> {
    if (this.#suspendedEval) {
      const lvl = this.currentDebug()?.level ?? "?";
      throw new Error(
        `a previous evaluation is suspended in the debugger at level ${lvl} — ` +
          `resolve it with the lisp_debug_* tools first`,
      );
    }
    const buf: string[] = [];
    this.#captureBuf = buf;
    const rexPromise = this.#client.rex(
      [sym("slynk:interactive-eval"), code],
      { pkg, interactive: true },
    );
    rexPromise.catch(() => {}); // a parked rex may reject later via abort
    const entered = deferred();
    this.#debugEntered = entered;
    try {
      const winner = await Promise.race([
        rexPromise.then((v) => ({ debug: false as const, value: v as string })),
        entered.promise.then(() => ({ debug: true as const, value: "" })),
      ]);
      if (!winner.debug) {
        this.#captureBuf = null;
        return { value: winner.value, output: buf.join("") };
      }
      // Suspended: keep #captureBuf installed so post-resume output is captured.
      this.#suspendedEval = { rexPromise, buf };
      return { value: "", output: buf.join(""), debugEntered: true };
    } finally {
      this.#debugEntered = null;
    }
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Ensure the test Slynk is running, then:

`SLYNK_TEST_PORT=4006 deno test --allow-net --allow-env --allow-read --allow-write --config deno.json src/integration_test.ts`

Expected: PASS — 3 tests passed.

- [ ] **Step 8: Verify formatting, lint, and types**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/session.ts src/integration_test.ts
git commit -m "feat: suspend lisp_eval in the debugger instead of auto-aborting

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Session — resume the parked eval from the debug tools

**Files:**
- Modify: `src/session.ts` (`debugInvokeRestart` ~330-337, `debugAbort` ~339-346, add `#resumeVia`)
- Test: `src/integration_test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/integration_test.ts`:

```ts
Deno.test({
  name: "debugInvokeRestart: a CONTINUE restart resumes the suspended eval",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      const r = await session.eval('(progn (cerror "go on" "stop here") 42)');
      assertEquals(r.debugEntered, true);
      const d = session.currentDebug()!;
      const cont = d.restarts.findIndex((x) => /^continue$/i.test(x.name));
      assert(cont >= 0, "expected a CONTINUE restart");
      const out = await session.debugInvokeRestart(cont);
      assertStringIncludes(out, "42");
      assertEquals(session.currentDebug(), null);
    } finally {
      await session.stop();
    }
  },
});

Deno.test({
  name: "debugAbort: reports the aborted evaluation",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      await session.eval("(/ 1 0)");
      const out = await session.debugAbort();
      assertStringIncludes(out.toLowerCase(), "abort");
      assertEquals(session.currentDebug(), null);
    } finally {
      await session.stop();
    }
  },
});

Deno.test({
  name: "debugInvokeRestart: a re-erroring restart re-enters the debugger",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      await session.eval("(/ 1 0)");
      const d = session.currentDebug()!;
      const retry = d.restarts.findIndex((x) => /^retry$/i.test(x.name));
      assert(retry >= 0, "expected a RETRY restart");
      const out = await session.debugInvokeRestart(retry);
      assertStringIncludes(out, "debugger");
      assertExists(session.currentDebug());
      await session.debugAbort();
    } finally {
      await session.stop();
    }
  },
});

Deno.test({
  name: "Session.eval: rejects a second eval while one is suspended",
  ignore,
  fn: async () => {
    const session = newSession();
    try {
      await session.eval("(/ 1 0)");
      await assertRejects(() => session.eval("(+ 1 1)"), Error, "suspended");
      await session.debugAbort();
    } finally {
      await session.stop();
    }
  },
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Ensure the test Slynk is running, then:

`SLYNK_TEST_PORT=4006 deno test --allow-net --allow-env --allow-read --allow-write --config deno.json src/integration_test.ts`

Expected: FAIL — the CONTINUE-resume, abort-report, and re-debug tests fail:
the current `debugInvokeRestart` / `debugAbort` send the restart but neither
resume nor report the parked eval, so `out` is the restart's own ack (not
`"42"` / not an "abort" notice / not a "debugger" notice). The "rejects a
second eval" test already passes — it guards the Task 2 behavior.

- [ ] **Step 3: Add `#resumeVia` and rewrite the resume tools**

In `src/session.ts`, replace `debugInvokeRestart` (~330-337) and `debugAbort`
(~339-346) with the following, and add the `#resumeVia` helper directly after
`debugAbort`:

```ts
  debugInvokeRestart(restartIndex: number): Promise<string> {
    const top = this.currentDebug();
    if (!top) throw new Error("Not in debugger");
    return this.#resumeVia(
      [sym("slynk:invoke-nth-restart-for-emacs"), top.level, restartIndex],
      { thread: top.thread },
    );
  }

  debugAbort(): Promise<string> {
    const top = this.currentDebug();
    if (!top) throw new Error("Not in debugger");
    return this.#resumeVia([sym("slynk:throw-to-toplevel")], { thread: top.thread });
  }

  /**
   * Send a restart / throw-to-toplevel form, then report the outcome of the
   * suspended eval: its value+output if it ran to completion, an aborted
   * notice if it unwound, or a re-entered-debugger notice if it errored again.
   */
  async #resumeVia(form: Sexp, opts: RexOptions): Promise<string> {
    const susp = this.#suspendedEval;
    const ack = this.#client.rex(form, opts);
    ack.catch(() => {});
    if (!susp) return print(await ack);

    const entered = deferred();
    this.#debugEntered = entered;
    let outcome:
      | { kind: "value"; value: string }
      | { kind: "abort"; message: string }
      | { kind: "redebug" };
    try {
      outcome = await Promise.race([
        susp.rexPromise.then(
          (v) => ({ kind: "value" as const, value: v as string }),
          (e) => ({ kind: "abort" as const, message: (e as Error).message }),
        ),
        entered.promise.then(() => ({ kind: "redebug" as const })),
      ]);
    } finally {
      this.#debugEntered = null;
    }

    if (outcome.kind === "redebug") {
      // Still suspended at a fresh level; defAsyncTool's debugSummary shows it.
      return "evaluation re-entered the debugger";
    }
    const output = susp.buf.join("");
    this.#suspendedEval = null;
    this.#captureBuf = null;
    if (outcome.kind === "value") {
      return (output ? `[stdout]\n${output}\n[value]\n` : "") + outcome.value;
    }
    return (output ? `[stdout]\n${output}\n` : "") +
      `evaluation aborted: ${outcome.message}`;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Ensure the test Slynk is running, then:

`SLYNK_TEST_PORT=4006 deno test --allow-net --allow-env --allow-read --allow-write --config deno.json src/integration_test.ts`

Expected: PASS — 7 tests passed.

- [ ] **Step 5: Verify formatting, lint, and types**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/session.ts src/integration_test.ts
git commit -m "feat: resume and report the parked eval from debug tools

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Tool layer — render the suspended-eval result

**Files:**
- Modify: `src/mcp/tool_helpers.ts` (`formatEvalResult` ~68-70)
- Modify: `src/mcp/tools.ts` (`lisp_eval` description ~32-33, `lisp_debug_invoke_restart` description ~236)
- Create: `src/mcp/tool_helpers_test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/mcp/tool_helpers_test.ts`:

```ts
import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatEvalResult } from "./tool_helpers.ts";

Deno.test("formatEvalResult: plain value", () => {
  assertEquals(formatEvalResult({ value: "42", output: "" }), "42");
});

Deno.test("formatEvalResult: value with captured stdout", () => {
  assertEquals(
    formatEvalResult({ value: "42", output: "hello\n" }),
    "[stdout]\nhello\n\n[value]\n42",
  );
});

Deno.test("formatEvalResult: debugEntered renders a suspended-eval notice", () => {
  const s = formatEvalResult({ value: "", output: "", debugEntered: true });
  assertStringIncludes(s, "suspended in the debugger");
  assertStringIncludes(s, "lisp_debug_");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-net --allow-env --config deno.json src/mcp/tool_helpers_test.ts`
Expected: FAIL — the `debugEntered` test fails; current `formatEvalResult`
returns `""` (empty `output`, empty `value`), so it contains neither expected
substring.

- [ ] **Step 3: Update `formatEvalResult`**

In `src/mcp/tool_helpers.ts`, replace `formatEvalResult` (~68-70):

```ts
export function formatEvalResult(r: EvalResult): string {
  if (r.debugEntered) {
    return (r.output ? `[stdout]\n${r.output}\n` : "") +
      "evaluation suspended in the debugger — inspect with the lisp_debug_* " +
      "tools, then resume with lisp_debug_invoke_restart or lisp_debug_abort";
  }
  return (r.output ? `[stdout]\n${r.output}\n[value]\n` : "") + r.value;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-net --allow-env --config deno.json src/mcp/tool_helpers_test.ts`
Expected: PASS — 3 tests passed.

- [ ] **Step 5: Update the affected tool descriptions**

In `src/mcp/tools.ts`, replace the `lisp_eval` `description` (~32-33):

```ts
      description: "Evaluate a Common Lisp expression in the running image. " +
        "Returns the printed value plus any captured stdout. If the evaluation " +
        "signals an error it suspends in the debugger — drive it with the " +
        "lisp_debug_* tools.",
```

Replace the `lisp_debug_invoke_restart` `description` (~236):

```ts
      description: "Invoke restart N (as listed by lisp_debug_status). If this " +
        "resumes a suspended evaluation, reports its value; if it re-errors, " +
        "reports the new debugger level.",
```

- [ ] **Step 6: Verify formatting, lint, and types**

Run: `deno task check`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tool_helpers.ts src/mcp/tool_helpers_test.ts src/mcp/tools.ts
git commit -m "feat: render the suspended-eval result in lisp_eval

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (debugger-flow paragraph)
- Modify: `README.md` (architecture intro ~12, Debugger section ~73-82)

- [ ] **Step 1: Update `CLAUDE.md`**

In `CLAUDE.md`, replace the paragraph that begins "Debugger flow:":

Old:

```
Debugger flow: Lisp error → `(:debug ...)` → `(:debug-activate ...)` triggers auto-abort via
`slynk:invoke-nth-restart-for-emacs` targeting the `ABORT` restart → `(:debug-return ...)` →
`(:return (:abort REASON) ID)` rejects the original rex.
```

New:

```
Debugger flow: a Lisp error sends `(:debug ...)` then `(:debug-activate ...)`. Whether swankmcp
auto-aborts depends on which request triggered it — decided by matching the `:debug` event's
pending-continuation ids against the client's interactive rex id (`client.ts` `#interactiveId`).
For `lisp_eval` (the only interactive request) the debugger is left open: `Session.eval` returns
early with `debugEntered`, the rex is parked in `#suspendedEval`, and the `lisp_debug_*` tools
drive it. `lisp_debug_invoke_restart` / `lisp_debug_abort` resume the parked rex and report its
value, an aborted notice, or a re-entered-debugger notice. For every other tool, `(:debug-activate
...)` triggers auto-abort via `slynk:invoke-nth-restart-for-emacs` targeting the `ABORT` restart →
`(:debug-return ...)` → `(:return (:abort REASON) ID)` rejects the rex.
```

- [ ] **Step 2: Update the `README.md` architecture intro**

In `README.md`, in the paragraph under "## Architecture", replace this sentence:

Old:

```
Errors that drop into the
Slynk debugger are surfaced as MCP tool errors carrying the condition + restart list, and a set of
`lisp_debug_*` tools let the model query frames, eval in frames, and invoke restarts (or abort).
```

New:

```
When an error from `lisp_eval` drops into the Slynk debugger the call suspends rather than failing:
the tool result describes the condition, restarts, and frames, and the `lisp_debug_*` tools let the
model query frames, eval in frames, and invoke a restart (or abort). Errors from every other tool
are auto-aborted and surfaced as MCP tool errors.
```

- [ ] **Step 3: Update the `README.md` Debugger section**

In `README.md`, replace the paragraph/heading under "### Debugger" — insert a
sentence before the table. Change:

Old:

```
### Debugger

| Tool                        | Description                                                                                |
```

New:

```
### Debugger

A `lisp_eval` error suspends in the debugger; these tools inspect and resume it. (Errors from other
tools are auto-aborted, so `lisp_debug_status` reports "not in debugger" for those.)

| Tool                        | Description                                                                                |
```

Also replace the `lisp_debug_invoke_restart` table row:

Old:

```
| `lisp_debug_invoke_restart` | Invoke restart N from the list shown by `lisp_debug_status`.                               |
```

New:

```
| `lisp_debug_invoke_restart` | Invoke restart N; reports the resumed evaluation's value, or the new debugger level.       |
```

- [ ] **Step 4: Verify formatting**

Run: `deno fmt --check CLAUDE.md README.md`
Expected: no errors. (If it reports diffs, run `deno fmt CLAUDE.md README.md` and re-check.)

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document the interactive lisp_eval debugger

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Step 1: Full check and unit test suite**

Run: `deno task check && deno test --allow-net --allow-env --config deno.json`
Expected: all unit tests pass; integration tests in `src/integration_test.ts`
report as "ignored" (no `SLYNK_TEST_PORT`).

- [ ] **Step 2: Full integration run**

Ensure the test Slynk is running, then:

`SLYNK_TEST_PORT=4006 deno test --allow-net --allow-env --allow-read --allow-write --config deno.json src/integration_test.ts`

Expected: PASS — 7 tests passed.

- [ ] **Step 3: Stop the test Slynk**

Run: `pkill -f start-test-slynk.lisp`
