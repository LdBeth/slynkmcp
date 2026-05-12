import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "../session.ts";
import { HandleStore } from "../handles.ts";
import { registerTools } from "./tools.ts";
import type { Config } from "../config.ts";
import { loadPlugins } from "../plugins/registry.ts";

export async function runServer(config: Config): Promise<void> {
  // Resolve plugin names up front so an unknown name aborts before we open the
  // Slynk socket.
  const plugins = loadPlugins(config.plugins);

  const session = new Session({
    host: config.host,
    port: config.port,
    defaultPackage: config.defaultPackage,
  });

  // Slynk connection is opened lazily on the first tool call, so the MCP
  // server boots even when the Lisp image isn't running yet.

  const pluginNote = plugins.length > 0
    ? ` Plugins active: ${plugins.map((p) => p.name).join(", ")}.`
    : "";

  const server = new McpServer(
    { name: "slynk-mcp-server", version: "0.1.0" },
    {
      capabilities: { tools: {} },
      instructions: `Bridge to a running Common Lisp image (Opusmodus) over Slynk on ` +
        `${config.host}:${config.port}. Default package: ${config.defaultPackage}. ` +
        `All core tools are prefixed 'lisp_'. ` +
        `Core: 'lisp_eval' runs Lisp code and returns value + captured stdout. ` +
        `Introspection: 'lisp_completions', 'lisp_apropos', 'lisp_describe_symbol', ` +
        `'lisp_documentation', 'lisp_arglist', 'lisp_macroexpand', 'lisp_find_definition'. ` +
        `Code loading: 'lisp_compile_file' (compile-for-emacs), 'lisp_load_file' (LOAD). ` +
        `Debugger: when eval errors, the condition + restarts are surfaced automatically; ` +
        `use 'lisp_debug_status', 'lisp_debug_invoke_restart', 'lisp_debug_abort', ` +
        `'lisp_debug_frame_locals', 'lisp_debug_frame_source', 'lisp_debug_eval_in_frame' ` +
        `to inspect and recover. ` +
        `Large results are truncated and stashed in handles; use 'lisp_get_handle' / ` +
        `'lisp_list_handles' to retrieve slices. 'lisp_interrupt' cancels a runaway computation. ` +
        `'lisp_connection_info' shows Lisp implementation, version, features, and package.` +
        pluginNote,
    },
  );

  const store = new HandleStore();
  const ctx = { session, store, maxResultChars: config.maxResultChars };
  registerTools(server, ctx);
  for (const plugin of plugins) {
    plugin.register(server, ctx);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Close the Slynk TCP connection when the MCP transport shuts down
  // (stdin closes, or the process receives SIGTERM/SIGINT).
  const shutdown = () => session.stop().catch(() => {});
  transport.onclose = shutdown;
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);
}
