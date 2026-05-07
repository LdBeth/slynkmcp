/**
 * Shared helpers used by core tool registration (`tools.ts`) and by plugins.
 *
 * Plugins should import `defAsyncTool`, `defTool`, the annotation presets, and
 * the `Ctx` type from here so they inherit handle truncation, debugger summary
 * appending, and the Zod 4 / MCP SDK type workaround.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Session } from "../session.ts";
import { HandleStore, maybeTruncate } from "../handles.ts";

export interface Ctx {
  session: Session;
  store: HandleStore;
  maxResultChars: number;
}

export type TextContent = { type: "text"; text: string };
export type ToolResult = { content: TextContent[]; isError?: boolean };

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
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

export function txt(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function defTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: {
    title?: string;
    description: string;
    inputSchema: S;
    annotations?: ToolAnnotations;
  },
  handler: (args: z.infer<z.ZodObject<S>>) => ToolResult | Promise<ToolResult>,
): void {
  server.registerTool(name, config, handler);
}

function format(store: HandleStore, kind: string, text: string, maxChars: number): string {
  return maybeTruncate(store, kind, text, maxChars).text;
}

function debugSummary(session: Session): string {
  const d = session.currentDebug();
  if (!d) return "";
  const restarts = d.restarts.map((r, i) => `  ${i}. ${r.name} — ${r.description}`).join("\n");
  const frames = d.frames.slice(0, 8).map((f) => `  #${f.index} ${f.description}`).join("\n");
  return `\n\n[DEBUGGER ACTIVE — level ${d.level}]\n` +
    `condition: ${d.condition.type}: ${d.condition.message}\n` +
    `restarts:\n${restarts}\n` +
    `top frames:\n${frames}`;
}

export function defAsyncTool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: Ctx,
  name: string,
  config: {
    title?: string;
    description: string;
    inputSchema: S;
    annotations?: ToolAnnotations;
  },
  kind: string,
  op: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
): void {
  defTool(server, name, config, async (args) => {
    try {
      const text = await op(args);
      return txt(format(ctx.store, kind, text, ctx.maxResultChars) + debugSummary(ctx.session));
    } catch (e) {
      return err((e as Error).message + debugSummary(ctx.session));
    }
  });
}
