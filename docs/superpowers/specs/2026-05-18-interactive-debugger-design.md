# Interactive debugger for `lisp_eval`

## Problem

swankmcp's `Session.onDebugActivate` (`session.ts:94-105`) auto-aborts **every**
debugger entry, unconditionally and fire-and-forget. By the time any MCP tool
handler runs, the Slynk debug level has already been popped, so `currentDebug()`
is always `null`. Consequences:

- `lisp_debug_status`, `lisp_debug_invoke_restart`, `lisp_debug_abort`,
  `lisp_debug_frame_locals`, `lisp_debug_frame_source`, `lisp_debug_eval_in_frame`
  are unreachable dead code — they always report "not in debugger".
- The `debugSummary` block that `defAsyncTool` appends to every tool result
  (`tool_helpers.ts:85-94`) never fires.
- A Lisp error surfaces only as `Slynk abort: #<…>` — the condition's printed
  form, with no restart list and no backtrace. This is less than the README
  describes.

## Goal

Make `lisp_eval` the one tool whose Lisp errors are **interactive**: when an
evaluation drops into the debugger, the model can inspect frames, eval in
frames, and choose a restart, instead of the error being silently aborted.

All other tools keep the current auto-abort behavior.

## Behavior

When a `lisp_eval` evaluation enters the Slynk debugger:

- `lisp_eval` returns *immediately* with a result describing the suspended
  state. It does **not** block waiting for the rex to settle.
- The underlying rex stays **parked** (pending) inside `SlynkClient`.
- The `lisp_debug_*` tools become live and drive that parked rex.

Every other tool (`lisp_compile_file`, `lisp_load_file`, `lisp_macroexpand`,
`lisp_debug_eval_in_frame`, …) keeps auto-abort — including a *nested* debugger
entered while inspecting frames.

This is the unconditional default; no config flag.

## Design

### Telling the interactive debugger apart

The `:debug` event's pending-continuations list names the exact rex id that
entered the debugger (verified against live SBCL Slynk: `pendingIds=[2]` for
rex id 2). Since only one `lisp_eval` is ever in flight (see Edge cases), this
needs no general matching:

- `SlynkClient.rex` gains an `interactive?: boolean` option. The client records
  the single `#interactiveId` (the id of the in-flight interactive rex), and
  clears it when that rex settles.
- When a `:debug` frame is parsed, the client computes
  `DebugInfo.interactive = pendingIds.includes(#interactiveId)` — a new boolean
  field on `DebugInfo`.
- `Session.onDebugActivate` auto-aborts **only when `!info.interactive`**. The
  existing handler body is wrapped in that guard; nothing else changes about it.

### `Session.eval` early return

`eval` resolves on whichever happens first: the rex returning, or an interactive
debugger activating for it.

- `EvalResult` gains `debugEntered?: boolean`.
- On debugger entry, `eval` resolves `{ debugEntered: true, output }` and stashes
  `#suspendedEval = { rexPromise, buf }` — the parked promise plus its capture
  buffer.
- The per-request output buffer stays installed as `#captureBuf` for the whole
  lifetime of the suspended eval, so stdout produced after a restart resumes is
  still captured and reported.
- The parked rex always has a `.catch` attached, so an eventual abort-rejection
  is never an unhandled rejection.
- `formatEvalResult` renders `debugEntered` as a short notice ("Evaluation
  suspended in the debugger — inspect with `lisp_debug_*`, resume with
  `lisp_debug_invoke_restart` / `lisp_debug_abort`"). The condition / restarts /
  frames block is already appended by `debugSummary` in `defAsyncTool`.

### Debug tools: resume and report

`debugInvokeRestart(i)` and `debugAbort()`:

1. Send the restart / `throw-to-toplevel` rex and await its own quick ack.
2. If `#suspendedEval` exists, race **[parked rex settles]** vs **[a new
   interactive `:debug` activates]**:
   - Rex resolves with a value → return `{ value, output }` built from the
     accumulated buffer; clear `#suspendedEval`, uninstall the buffer.
   - Rex rejects (abort) → report aborted + output; clear state.
   - New debugger activates → return a short note; `debugSummary` auto-appends
     the new level's details; `#suspendedEval` stays parked for further driving.

`lisp_debug_status`, `lisp_debug_frame_locals`, `lisp_debug_frame_source` are
unchanged — they already work; they were merely unreachable.

### Edge cases & error handling

- **Concurrent / re-entrant `lisp_eval`:** if `#suspendedEval` is set, `eval`
  rejects fast: "a previous evaluation is suspended in the debugger at level N —
  resolve it via `lisp_debug_*` first".
- **`lisp_debug_eval_in_frame` errors:** its rex is non-interactive, so the
  nested debugger auto-aborts; the level-1 interactive debugger is untouched.
- **Disconnect while suspended:** the existing readLoop teardown rejects the
  parked rex; `onDisconnect` also clears `#suspendedEval`.
- **Parked rex never resolved by the model:** harmless (a parked Lisp thread).
  `lisp_interrupt` and `lisp_debug_abort` are the escapes. No timeout added.

## Testing

- Unit: `SlynkClient` records `#interactiveId`; `DebugInfo.interactive` is set
  correctly from `pendingIds`.
- Integration against live SBCL Slynk:
  - `lisp_eval` of `(/ 1 0)` → returns a suspended result carrying the debug
    block; does not block.
  - `lisp_debug_frame_locals` / `lisp_debug_frame_source` /
    `lisp_debug_eval_in_frame` work against the suspended level.
  - `lisp_debug_invoke_restart` of a `CONTINUE` / `USE-VALUE`-style restart
    resumes the evaluation and reports its final value + output.
  - `lisp_debug_abort` reports the aborted outcome.
  - A non-`lisp_eval` error (e.g. `lisp_compile_file` of a broken file) still
    auto-aborts.
- Docs: update `CLAUDE.md` (debugger flow paragraph) and `README.md` (which
  already describes this workflow as if it worked).

## Out of scope

- No interactive debugger for tools other than `lisp_eval`.
- No configurable auto-abort policy / no opt-out flag.
- No debugger-entry timeout.
