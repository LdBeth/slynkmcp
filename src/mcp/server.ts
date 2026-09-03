import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { Session } from "../session.ts";
import { registerTools } from "./tools.ts";
import type { Config } from "../config.ts";
import { loadPlugins } from "../plugins/registry.ts";

export async function runServer(config: Config): Promise<void> {
  // Resolve plugin names up front so an unknown name aborts before we open the
  // Slynk socket.
  const plugins = loadPlugins(config.plugins);

  const session = new Session(config);

  // Slynk connection is opened lazily on the first tool call, so the MCP
  // server boots even when the Lisp image isn't running yet.

  const pluginNote = plugins.length > 0
    ? "\n\n" + plugins.map((p) => p.instructions).join("\n\n")
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
        `Lisp errors are auto-aborted from the debugger; the tool result is an error report ` +
        `naming the condition, the file and line it was signalled at, the backtrace, and any ` +
        `output printed before the failure. Code sent as a string has no file behind it, so ` +
        `load definitions with 'lisp_compile_file' when you want errors placed in source. ` +
        `Large results are truncated and stashed in handles; use 'lisp_get_handle' / ` +
        `'lisp_list_handles' to retrieve slices. 'lisp_interrupt' cancels a runaway computation. ` +
        `'lisp_connection_info' shows Lisp implementation, version, features, and package.` +
        pluginNote,
    },
  );

  const ctx = { session, maxResultChars: config.maxResultChars };
  registerTools(server, ctx);
  for (const plugin of plugins) {
    plugin.register(server, ctx);
  }

  const transport = new StdioServerTransport();

  // Close the Slynk TCP connection when the MCP transport shuts down
  // (stdin closes, or the process receives SIGTERM/SIGINT).
  // Must be wired before connect() so a fast close doesn't miss the event.
  const shutdown = () => session.stop().catch(() => {});
  transport.onclose = shutdown;
  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);

  await server.connect(transport);
}
