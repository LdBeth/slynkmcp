/**
 * Shared helpers used by core tool registration (`tools.ts`) and by plugins.
 *
 * Plugins should import `defAsyncTool`, `defTool`, the annotation presets, and
 * the `Ctx` type from here so they inherit handle truncation.
 *
 * Types come straight from the MCP SDK: `ToolAnnotations` and `CallToolResult`
 * from the protocol types, and `ZodRawShapeCompat` / `ShapeOutput` from the
 * SDK's Zod-compat layer, which already bridges Zod 3 and Zod 4.
 *
 * `defTool` types the handler with a concrete `(args: ShapeOutput<S>) => …`
 * signature rather than the SDK's `ToolCallback<S>`: `ToolCallback` is a
 * deferred conditional type, and TS will not contextually infer arrow-function
 * parameter types through one. The concrete signature gives callers typed
 * `args` and is still assignable to what `registerTool` expects.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { EvalResult, Session } from "../session.ts";

export interface Ctx {
  session: Session;
  maxResultChars: number;
}

export type ToolConfig<S extends ZodRawShapeCompat> = {
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
};

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

export type ToolHandler<S extends ZodRawShapeCompat> = (
  args: ShapeOutput<S>,
) => CallToolResult | Promise<CallToolResult>;

export function defTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  config: ToolConfig<S>,
  handler: ToolHandler<S>,
): void {
  server.registerTool(name, config, handler);
}

export function defAsyncTool<S extends ZodRawShapeCompat>(
  server: McpServer,
  ctx: Ctx,
  name: string,
  config: ToolConfig<S>,
  kind: string,
  op: (args: ShapeOutput<S>) => Promise<string>,
): void {
  defTool(server, name, config, async (args) => {
    try {
      const text = await op(args);
      return txt(ctx.session.truncate(kind, text, ctx.maxResultChars));
    } catch (e) {
      return err((e as Error).message);
    }
  });
}
