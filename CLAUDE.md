# CLAUDE.md

## Architecture

The pipeline is: **main.ts → server.ts → Session → SlynkClient → TCP socket to Slynk :4005**

Session owns the client and offers a high-level API (`eval`, `arglist`, `apropos`, inspector,
debugger). MCP tool handlers (`src/mcp/tools.ts`) are thin wrappers that call Session methods and
format the result.

Output capture (`session.ts:117-131`) serializes eval calls through a mutex queue so asynchronous
`:write-string` events from Slynk can be buffered into a per-request `#captureBuf`. When the rex
resolves, the buffer is joined as the `output` field. This is needed because Slynk doesn't tie
stdout to request ids.

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

Debugger flow: a Lisp error sends `(:debug ...)` then `(:debug-activate ...)`. Whether swankmcp
auto-aborts depends on which request triggered it — decided by matching the `:debug` event's
pending-continuation ids against the client's interactive rex id (`client.ts` `#interactiveId`). For
`lisp_eval` (the only interactive request) the debugger is left open: `Session.eval` returns early
with `debugEntered`, the rex is parked in `#suspendedEval`, and the `lisp_debug_*` tools drive it.
`lisp_debug_invoke_restart` / `lisp_debug_abort` resume the parked rex and report its value, an
aborted notice, or a re-entered-debugger notice. For every other tool, `(:debug-activate
...)`
triggers auto-abort via `slynk:invoke-nth-restart-for-emacs` targeting the `ABORT` restart →
`(:debug-return ...)` → `(:return (:abort REASON) ID)` rejects the rex.

## Tool registration types

Register async tools by calling `server.registerTool(name, config, asyncHandler(ctx, kind, op))`
directly (see `src/mcp/tools.ts` and plugins). `asyncHandler` (`src/mcp/tool_helpers.ts`) wraps an
`op: (args) => Promise<string>` with handle truncation and error→`isError` conversion.
`asyncHandler<A>` is generic over the *resolved* args object type, not the raw Zod shape, so it
sidesteps the SDK's deferred `ToolCallback` conditional: the literal `config` at each call site
pins the input shape, TS resolves the conditional, and `op` gets typed `args` — no casts.

**Import the SDK without `.js`** — `@modelcontextprotocol/sdk/server/mcp`, not `…/mcp.js`. The
`.js` path resolves `McpServer` to `any`, silently disabling all `registerTool` typechecking.
