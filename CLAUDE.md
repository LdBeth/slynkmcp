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

Debugger flow: Lisp error → `(:debug ...)` → `(:debug-activate ...)` triggers auto-abort via
`slynk:invoke-nth-restart-for-emacs` targeting the `ABORT` restart → `(:debug-return ...)` →
`(:return (:abort REASON) ID)` rejects the original rex.

## Zod 4 + MCP SDK type issue

The SDK's `registerTool` callback inference breaks with Zod 4 in Deno (TS7031). The workaround is
`defTool<S extends z.ZodRawShape>()` in `tools.ts:34-42` which does its own
`z.infer<z.ZodObject<S>>` for the handler args, then casts through `as any` to register.
