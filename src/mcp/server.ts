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
        `Core: 'eval' runs Lisp code and returns value + captured stdout. ` +
        `Introspection: 'completions', 'apropos', 'describe_symbol', 'documentation', ` +
        `'arglist', 'macroexpand', 'find_definition'. ` +
        `Inspector: 'inspect' an object, 'inspect_part', 'inspector_pop', 'inspector_reinspect'. ` +
        `Code loading: 'compile_file' (compile-for-emacs), 'load_file' (LOAD). ` +
        `Debugger: when eval errors, the condition + restarts are surfaced automatically; ` +
        `use 'debug_status', 'debug_invoke_restart', 'debug_abort', 'debug_frame_locals', ` +
        `'debug_frame_source', 'debug_eval_in_frame' to inspect and recover. ` +
        `Large results are truncated and stashed in handles; use 'get_handle' / 'list_handles' ` +
        `to retrieve slices. 'interrupt' cancels a runaway computation. ` +
        `'connection_info' shows Lisp implementation, version, features, and package.`,
    },
  );

  const store = new HandleStore();
  registerTools(server, { session, store, maxResultChars: config.maxResultChars });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Close the Slynk TCP connection when the MCP transport shuts down
  // (stdin closes, or the process receives SIGTERM/SIGINT).
  const shutdown = () => session.stop().catch(() => {});
  transport.onclose = shutdown;
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);
}
