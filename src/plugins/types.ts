import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../mcp/tool_helpers.ts";

/**
 * A plugin extends the MCP surface with extra tools tied to a specific Lisp
 * environment (e.g. Opusmodus). Plugins are activated explicitly via the
 * `--plugin=<name>` CLI flag or `SWANKMCP_PLUGINS` env var.
 *
 * `register` is called once at startup, after the core tools are wired. It
 * receives the same `Ctx` used by core tools so plugin tools inherit handle
 * truncation.
 */
export interface Plugin {
  readonly name: string;
  readonly instructions: string;
  register(server: McpServer, ctx: Ctx): void;
}
