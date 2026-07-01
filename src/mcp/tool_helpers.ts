/**
 * Shared helpers used by core tool registration (`tools.ts`) and by plugins.
 *
 * `asyncHandler` wraps an async `op` into an MCP tool handler — pass its result
 * straight to `server.registerTool` as the callback. Plugins should import it,
 * the annotation presets, and the `Ctx` type from here so their tools inherit
 * handle truncation.
 *
 * `ToolAnnotations` and `CallToolResult` come straight from the MCP SDK's
 * protocol types.
 */

import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types";
import type { Session } from "../session.ts";

export interface Ctx {
  session: Session;
  maxResultChars: number;
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const MUTATING: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const STATEFUL_READ: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

export function txt(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function err(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Shared shell for all three handler wrappers below: run `op`, project a
 * successful result through `onSuccess`, and convert any thrown error into an
 * `isError` result. `asyncHandler`, `asyncStructuredHandler`, and
 * `asyncSideEffect` differ only in `onSuccess` — factored out here so the
 * try/catch is written once.
 */
function toResultHandler<A, R>(
  op: (args: A) => Promise<R>,
  onSuccess: (result: R) => CallToolResult,
): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return onSuccess(await op(args));
    } catch (e) {
      return err((e as Error).message);
    }
  };
}

/**
 * Wrap an async `op` into a tool handler: run `op`, truncate its result string
 * through the session handle store (keyed by `kind`), and convert any thrown
 * error into an `isError` result.
 *
 * Generic over the args object type `A` rather than the raw input shape, so it
 * stays clear of the SDK's deferred `ToolCallback` conditional. At each call
 * site `registerTool` pins `A` from the tool's `inputSchema`, so the returned
 * handler is assignable and `op` still receives typed `args`.
 */
export function asyncHandler<A>(
  ctx: Ctx,
  kind: string,
  op: (args: A) => Promise<string>,
): (args: A) => Promise<CallToolResult> {
  return toResultHandler(op, (text) => txt(ctx.session.truncate(kind, text, ctx.maxResultChars)));
}

/**
 * Like {@link asyncHandler} but `op` returns both a human-readable `text` and a
 * `structured` object that is sent as `structuredContent` in the tool result.
 * When an `outputSchema` is set on the tool, clients can consume the structured
 * data directly instead of parsing the text.
 */
export function asyncStructuredHandler<A>(
  op: (args: A) => Promise<CallToolResult["structuredContent"]>,
): (args: A) => Promise<CallToolResult> {
  return toResultHandler(op, (structured) => ({ content: [], structuredContent: structured }));
}

/**
 * Wrap an async side-effect op (no return value) into a tool handler.
 * Returns empty content on success; converts thrown errors to `isError` results.
 */
export function asyncSideEffect<A>(
  op: (args: A) => Promise<unknown>,
): (args: A) => Promise<CallToolResult> {
  return toResultHandler(op, () => ({ content: [] }));
}
