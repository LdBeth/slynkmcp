import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "../session.ts";
import { HandleStore } from "../handles.ts";
import { registerTools } from "./tools.ts";
import type { Config } from "../config.ts";

export async function runServer(config: Config): Promise<void> {
  const session = new Session({
    host: config.host,
    port: config.port,
    defaultPackage: config.defaultPackage,
  });

  await session.start(config.host, config.port);

  const server = new McpServer(
    { name: "swankmcp", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: `Bridge to a running Common Lisp image (Opusmodus) over Slynk on ` +
        `${config.host}:${config.port}. Default package: ${config.defaultPackage}. ` +
        `Use 'eval' for code, 'describe_symbol'/'arglist'/'apropos' for introspection. ` +
        `When an evaluation triggers an error, the debugger info is appended to the result and ` +
        `the 'debug_*' tools are usable until you call debug_abort or debug_invoke_restart.`,
    },
  );

  const store = new HandleStore();
  registerTools(server, { session, store, maxResultChars: config.maxResultChars });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Keep the process alive until stdin closes; the SDK handles that internally.
}
