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

Debugger flow: a Lisp error sends `(:debug ...)` then `(:debug-activate ...)`. swankmcp currently
auto-aborts every debugger entry, regardless of which tool triggered it. On `(:debug-activate ...)`
the client invokes `slynk:invoke-nth-restart-for-emacs` targeting the `ABORT` restart (falling back
to the last restart by index if no `ABORT` is present) → `(:debug-return ...)` →
`(:return (:abort
REASON) ID)` rejects the rex, and the tool result surfaces the condition text.

An interactive-debugger plugin (parking the `lisp_eval` rex and exposing `lisp_debug_*` tools to
drive restarts / frames / eval-in-frame) is an intentional extension point but is **not yet
implemented**. If you add it: discriminate eval-vs-other requests via the `:debug` event's
pending-continuation ids (currently dropped at `client.ts` — the `PENDING-IDS` field of the event
needs to be parsed and surfaced), and keep the auto-abort path as the default for non-eval tools.

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
