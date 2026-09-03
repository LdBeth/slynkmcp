# CLAUDE.md

## Architecture

The pipeline is: **main.ts → server.ts → Session → SlynkClient → TCP socket to Slynk :4005**

Session owns the client and offers a high-level API (`eval`, `arglist`, `apropos`, inspector,
debugger). MCP tool handlers (`src/mcp/tools.ts`) are thin wrappers that call Session methods and
format the result.

Output capture: every Session-level rex is serialized through `#queue` (`session.ts` `#runQueued`),
so only one rex is in flight at a time. `eval()` sets `#captureBuf` for the duration of its rex
call; non-eval rexes never set the buffer, so async `:write-string` events from Slynk can't be
misattributed across calls. The buffer is joined as the `output` field when the eval rex resolves.
This is needed because Slynk doesn't tie stdout to request ids.

Large results (>8000 chars by default) are truncated and stashed in a 64-entry LRU `HandleStore`;
the model retrieves slices via the `get_handle` tool.

## Slynk protocol

Frame format: 6-hex-digit ASCII length prefix + UTF-8 s-expression body. Codec in
`src/slynk/framing.ts` and `src/slynk/sexp.ts`.

**Critical — Slynk does NOT export `swank:`.** All RPC symbols live under `slynk:`, `slynk-mrepl:`,
`slynk-apropos:`, etc. Using `swank:` returns `(:reader-error ...)` with no matching `:return`,
which would hang the rex forever if the client didn't handle `:reader-error` by failing the
most-recent pending request (`client.ts:272-284`).

Core RPCs: `slynk:connection-info`, `slynk:interactive-eval`, `slynk:operator-arglist`,
`slynk:simple-completions`, `slynk:describe-symbol`, `slynk:documentation-symbol`,
`slynk:slynk-macroexpand-1`/`-all`, `slynk:find-definitions-for-emacs`,
`slynk:compile-file-for-emacs`, `slynk:load-file`. Apropos: `slynk-apropos:apropos-list-for-emacs`
(requires loading `slynk/apropos` contrib). mREPL: `slynk-mrepl:create-mrepl` creates a channel;
eval still uses `slynk:interactive-eval` (mREPL has no `listener-eval` RPC).

**`slynk:compile-file-for-emacs` never loads the fasl**, whatever `load-p` says:
`slynk-compile-file*` passes `nil` for the backend's own `load-p` and only echoes the requested flag
back in the result's LOADP field — in SLY it is the Emacs side that loads. So `Session.compileFile`
parses the `(:compilation-result NOTES SUCCESSP DURATION LOADP FASLFILE)` list and sends
`slynk:load-file` for the fasl itself when a load was asked for and the compile produced one. Do not
drop that second rex: without it `lisp_compile_file` reports a clean compile while defining nothing,
and the next call fails with an undefined function. `src/slynk/compilation.ts` owns the parse and
the rendering (status line, load outcome, then each note with severity, location, message, and
`:source-context` enclosing form); a failed load throws with the compilation summary prepended to
the load error.

Debugger flow: a Lisp error sends `(:debug ...)` then `(:debug-activate ...)`. swankmcp auto-aborts
every debugger entry, regardless of which tool triggered it — but it interrogates the debugger
first, because the frames stop existing the moment it unwinds.

`src/slynk/debug.ts` owns the model: `parseDebugEvent` turns the event into a `DebugInfo`
(condition, restarts, frames, and the `PENDING-IDS` continuation ids), `SlynkDebugError` carries
that snapshot out as a rejection, and `formatDebugReport` renders the text the model reads. The
report exists to answer _where the error came from_: it leads with an `Error source` headline naming
the innermost frame Slynk could place in a file, plus the line and the snippet Slynk sends with it.
When nothing placed, `sourceSection` says `not recorded` as a plain fact and falls back to naming
the innermost frame `frameOrigin` classifies as `application` — on an image whose libraries ship
without recorded source, that frame is the best answer left. (Opusmodus is such an image:
`lisp_find_definition` on `gen-repeat` answers `Cannot resolve location: :unknown`, so no `om` frame
can ever place and this path is the common one, not an edge case.) That fallback line reads
`Innermost application frame:` and **not** "your own code": on this image an application frame is
routinely a library's, and a live LispWorks test with the old wording presented
`(error #<undefined-function …>)` as the caller's own code. Its three variants are probing disabled,
a stack that is entirely host and Slynk frames, and N probed frames with none placed; the last two
both end with the `lisp_compile_file` remedy, plus the caveat that LispWorks eliminates tail calls —
a caller whose body ends in the failing call leaves no frame at all, and compiling from a file
cannot conjure back one the compiler removed.

1. `client.ts` parses `(:debug ...)` and files the `DebugInfo` under every parked rex id from
   `PENDING-IDS` (falling back to the highest pending id, sound for the same serialization reason as
   `:reader-error`). **First entry wins** — a nested level raised by the detail rexes below must not
   overwrite the caller's original condition.
2. `Session.#handleDebug` (`session.ts`) collects `slynk:backtrace` when `SLYNK_DEBUG_FRAMES`
   (default 32) exceeds the 20 frames Slynk volunteers, then classifies the frames before spending
   any probe on them. `#resolveFramePackages` sends **one batched rex** — a `cl:list` of one
   `cl:find-symbol` lookup per distinct frame head — and files each head's home package name back
   onto its frames. **Classification is by home package, resolved on the Lisp side, never by the
   package prefix printed in the frame description.** A Lisp omits the prefix for any symbol
   accessible in `*package*`, and the default package here is `om`, which inherits `common-lisp`: so
   `common-lisp:error` prints as bare `error`, exactly like one of the caller's own functions, and
   only packages foreign to `om` print a prefix at all. The old rule ("a frame with no package
   prefix is the caller's own code") was thus inverted, and worked only by accident on the frames
   that happened to be foreign — a live LispWorks test had it name `(error #<undefined-function …>)`
   as the user's own code. Do not reintroduce it. `homePackageForm` uses `find-symbol` rather than
   `read-from-string` on purpose: reading would intern every junk token in a backtrace into the
   user's package. For the same reason the form uses no `let` — even the variable names would be
   interned — so the lookup is spelled out repeatedly instead of bound.
3. `#locateFrames` then asks `slynk:frame-source-location` for the innermost `SLYNK_DEBUG_SOURCES`
   frames (default 8; `0` disables the probes and the package rex with them) — one round trip each,
   skipping Slynk's `[error printing frame]` placeholder, which won't place either, and every frame
   `frameOrigin` (`debug.ts`) calls `library`: a package in `INFRASTRUCTURE_PACKAGES` or matching
   `INFRASTRUCTURE_PREFIXES` (the host's `common-lisp`, `system`, `conditions`, `clos`, LispWorks
   `hcl`/`lw`/`mp`/`dbg`, `ccl`, `excl`, plus every `slynk…` contrib and `sb-…` internal). **Do not
   "simplify" the deny list away.** Every eval runs through `slynk:interactive-eval`, whose source
   file is right there on disk, so without it the innermost frame carrying _any_ location is
   routinely Slynk's own `slynk.lisp` — a live LispWorks test produced exactly that headline,
   pointing the reader at the bridge instead of the error.

   `frameOrigin` returns `application` only for a **resolved** home package; a bare head whose
   lookup failed stays `unknown`, still probed (it might place) but never named, so a failed lookup
   degrades to silence rather than to a confident wrong answer.

   **`OPUSMODUS` is deliberately absent from the deny list, and adding it to save probes would be
   wrong.** On that image the caller's own definitions and Opusmodus's own both live in `OPUSMODUS`,
   because code evaluated or compiled through the bridge is read in the default package. No package
   test separates them; what does is whether Slynk has a source location, which is what probing
   finds out.

4. `#abortDebug` invokes `slynk:invoke-nth-restart-for-emacs`, preferring the restart Slynk marks
   with a `*` prefix (`*sly-db-quit-restart*`, which returns from the RPC), then a plain `ABORT`,
   then the last restart. Do not go back to matching `ABORT` first: on most backends the unmarked
   `ABORT` aborts the whole worker thread. Restarts are parsed for this choice only — they are never
   printed, because nothing downstream can invoke one and listing them only padded the report.
5. `(:debug-return ...)` → `(:return (:abort REASON) ID)` rejects the rex with `SlynkDebugError`,
   and `asyncHandler` & co. render it through `describeError`, truncated into the handle store under
   kind `error` so a long backtrace stays retrievable via `lisp_get_handle`. `REASON` is no longer a
   report line of its own; it only fills in when the condition itself printed as nothing.

Throughout: `#collectingDebug` guards re-entry, so an error inside a detail rex opens a nested level
that is aborted immediately rather than collected, and every detail rex is capped at
`DEBUG_RPC_TIMEOUT_MS` so a backend that stops answering can't park the tool call in the debugger.
Frame locals are deliberately gone — no `slynk:frame-locals-and-catch-tags` call, nothing in the
report. A live LispWorks test showed locals were usually empty on exactly the frames that mattered,
and they were never the point; the location is. Do not add them back.

`Session.#evalOnce` attaches the captured output to the error before rethrowing, so what the form
printed before it broke survives into the report.

An interactive-debugger plugin (parking the `lisp_eval` rex and exposing `lisp_debug_*` tools to
drive restarts / frames / eval-in-frame) is an intentional extension point but is **not yet
implemented**. The groundwork is in place: `DebugInfo.pendingIds` already discriminates
eval-vs-other requests, and `SlynkClient.debugStack` tracks live levels. If you add it, keep the
auto-abort path as the default for non-eval tools.

**Reserved extension points (not yet consumed by `Session`):**

- **`SlynkClient.debugStack`** — public field; only mutated internally but exposed so a future
  interactive-debugger plugin can read the live debug stack without going through `Session`.
- **`SlynkEvents.onDebugReturn`** — fired after `(:debug-return ...)` clears a debug level; needed
  by the interactive-debugger plugin to know when a restart has been invoked and the level has
  closed.
- **`SlynkEvents.onNewFeatures`** — fired on `(:new-features ...)` from Slynk; reserved for
  contrib-aware clients.
- **`SlynkEvents.onIndentationUpdate`** — fired on `(:indentation-update ...)` from Slynk; reserved
  for IDE-style indentation integration.
- **`SlynkEvents.onUnknown`** — catch-all for unrecognized events; reserved for debugging and future
  protocol extensions.

`Session` wires up only `onWriteString`, `onChannelSend`, `onDebugActivate`, and `onDisconnect`. Do
not remove the remaining hooks from `SlynkEvents` or make `debugStack` private — they are
intentional extension points for the interactive-debugger plugin described above.

## Tool registration types

Register async tools by calling `server.registerTool(name, config, asyncHandler(ctx, kind, op))`
directly (see `src/mcp/tools.ts` and plugins). `asyncHandler` (`src/mcp/tool_helpers.ts`) wraps an
`op: (args) => Promise<string>` with handle truncation and error→`isError` conversion.
`asyncHandler<A>` is generic over the _resolved_ args object type, not the raw Zod shape, so it
sidesteps the SDK's deferred `ToolCallback` conditional: the literal `config` at each call site pins
the input shape, TS resolves the conditional, and `op` gets typed `args` — no casts.

**Import the SDK without `.js`** — `@modelcontextprotocol/sdk/server/mcp`, not `…/mcp.js`. The `.js`
path resolves `McpServer` to `any`, silently disabling all `registerTool` typechecking.
