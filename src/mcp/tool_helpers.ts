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
import type { EvalResult, Session } from "../session.ts";

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

export function formatEvalResult(r: EvalResult): string {
  return (r.output ? `[stdout]\n${r.output}\n[value]\n` : "") + r.value;
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
  return async (args) => {
    try {
      const text = await op(args);
      return txt(ctx.session.truncate(kind, text, ctx.maxResultChars));
    } catch (e) {
      return err((e as Error).message);
    }
  };
}
