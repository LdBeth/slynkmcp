/**
 * MCP tool definitions. Each tool is registered against the McpServer and
 * delegates to the Session for actual Slynk RPC.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Session } from "../session.ts";
import { HandleStore, maybeTruncate } from "../handles.ts";
import { print } from "../slynk/sexp.ts";

interface Ctx {
  session: Session;
  store: HandleStore;
  maxResultChars: number;
}

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[]; isError?: boolean };

function txt(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * Wrapper around `server.registerTool` that infers handler args from the Zod
 * shape — the SDK's own callback inference doesn't work with Zod 4 in Deno
 * (TS7031), so we do it here once.
 */
function defTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title?: string; description: string; inputSchema: S },
  handler: (args: z.infer<z.ZodObject<S>>) => ToolResult | Promise<ToolResult>,
): void {
  // deno-lint-ignore no-explicit-any
  server.registerTool(name, config as any, handler as any);
}

function format(ctx: Ctx, kind: string, text: string): string {
  const r = maybeTruncate(ctx.store, kind, text, ctx.maxResultChars);
  return r.text;
}

function debugSummary(ctx: Ctx): string {
  const d = ctx.session.currentDebug();
  if (!d) return "";
  const restarts = d.restarts.map((r, i) => `  ${i}. ${r.name} — ${r.description}`).join("\n");
  const frames = d.frames.slice(0, 8).map((f) => `  #${f.index} ${f.description}`).join("\n");
  return `\n\n[DEBUGGER ACTIVE — level ${d.level}]\n` +
    `condition: ${d.condition.type}: ${d.condition.message}\n` +
    `restarts:\n${restarts}\n` +
    `top frames:\n${frames}`;
}

export function registerTools(server: McpServer, ctx: Ctx): void {
  const { session } = ctx;

  // ---- core eval ----

  defTool(server, "eval", {
    title: "Evaluate Lisp",
    description:
      "Evaluate a Common Lisp expression in the running image. Returns the printed value plus any captured stdout. Defaults to the configured Opusmodus package.",
    inputSchema: {
      code: z.string().describe("Lisp source to evaluate"),
      package: z.string().optional().describe("Override the default package"),
    },
  }, async ({ code, package: pkg }) => {
    try {
      const r = await session.listenerEval(code, pkg);
      const body = (r.output ? `[stdout]\n${r.output}\n[value]\n` : "") + r.value;
      return txt(format(ctx, "eval", body) + debugSummary(ctx));
    } catch (e) {
      return err(`${(e as Error).message}${debugSummary(ctx)}`);
    }
  });

  defTool(server, "compile_file", {
    title: "Compile a Lisp file",
    description:
      "Compile a file via swank:compile-file-for-emacs. Optionally load the resulting fasl.",
    inputSchema: {
      path: z.string().describe("Absolute path to the .lisp file"),
      load: z.boolean().optional().default(true),
    },
  }, async ({ path, load }) => {
    try {
      const r = await session.compileFile(path, load);
      return txt(format(ctx, "compile", print(r)) + debugSummary(ctx));
    } catch (e) {
      return err((e as Error).message + debugSummary(ctx));
    }
  });

  defTool(server, "load_file", {
    title: "Load a Lisp file",
    description: "LOAD a file in the running image.",
    inputSchema: { path: z.string() },
  }, async ({ path }) => {
    try {
      const r = await session.loadFile(path);
      return txt(format(ctx, "load", print(r)) + debugSummary(ctx));
    } catch (e) {
      return err((e as Error).message + debugSummary(ctx));
    }
  });

  defTool(server, "interrupt", {
    title: "Interrupt running computation",
    description: "Send :emacs-interrupt to the REPL thread.",
    inputSchema: {},
  }, () => {
    session.interrupt();
    return Promise.resolve(txt("interrupt sent"));
  });

  // ---- introspection ----

  defTool(server, "completions", {
    title: "Symbol completions",
    description: "Flex-style symbol completions for a prefix.",
    inputSchema: {
      prefix: z.string(),
      package: z.string().optional(),
    },
  }, async ({ prefix, package: pkg }) => {
    const r = await session.completions(prefix, pkg);
    return txt(format(ctx, "completions", r.join("\n")));
  });

  defTool(server, "apropos", {
    title: "Apropos search",
    description: "Search for symbols matching a substring.",
    inputSchema: {
      pattern: z.string(),
      externalOnly: z.boolean().optional().default(true),
    },
  }, async ({ pattern, externalOnly }) => {
    const r = await session.apropos(pattern, externalOnly);
    return txt(format(ctx, "apropos", r));
  });

  defTool(server, "describe_symbol", {
    title: "Describe a symbol",
    description: "Full describe output for a symbol (function/variable/class).",
    inputSchema: { symbol: z.string() },
  }, async ({ symbol }) => txt(format(ctx, "describe", await session.describe(symbol))));

  defTool(server, "documentation", {
    title: "Symbol docstring",
    description: "DOCUMENTATION string for a symbol.",
    inputSchema: { symbol: z.string() },
  }, async ({ symbol }) => txt(format(ctx, "doc", await session.documentation(symbol))));

  defTool(server, "arglist", {
    title: "Operator arglist",
    description: "Argument list for a function/macro.",
    inputSchema: { symbol: z.string() },
  }, async ({ symbol }) => txt(format(ctx, "arglist", await session.arglist(symbol))));

  defTool(
    server,
    "macroexpand",
    {
      title: "Macro-expand a form",
      description: "Macroexpand-1 by default, or fully expand all macros.",
      inputSchema: {
        form: z.string(),
        all: z.boolean().optional().default(false),
      },
    },
    async ({ form, all }) => txt(format(ctx, "macroexpand", await session.macroexpand(form, all))),
  );

  defTool(
    server,
    "find_definition",
    {
      title: "Find symbol definition",
      description: "Source locations for a symbol's definitions.",
      inputSchema: { symbol: z.string() },
    },
    async ({ symbol }) => txt(format(ctx, "find-def", print(await session.findDefinition(symbol)))),
  );

  // ---- inspector ----

  defTool(
    server,
    "inspect",
    {
      title: "Inspect an expression",
      description: "Open the inspector on the result of an expression. Returns inspector parts.",
      inputSchema: { expression: z.string() },
    },
    async ({ expression }) => txt(format(ctx, "inspect", print(await session.inspect(expression)))),
  );

  defTool(server, "inspect_part", {
    title: "Inspect a part",
    description: "Drill into part N of the current inspector view.",
    inputSchema: { index: z.number().int().nonnegative() },
  }, async ({ index }) => txt(format(ctx, "inspect", print(await session.inspectorPart(index)))));

  defTool(server, "inspector_pop", {
    title: "Pop inspector",
    description: "Return to the previous inspector level.",
    inputSchema: {},
  }, async () => txt(format(ctx, "inspect", print(await session.inspectorPop()))));

  defTool(server, "inspector_reinspect", {
    title: "Reinspect current",
    description: "Re-inspect the current object.",
    inputSchema: {},
  }, async () => txt(format(ctx, "inspect", print(await session.inspectorReinspect()))));

  // ---- debugger ----

  defTool(server, "debug_status", {
    title: "Current debugger state",
    description:
      "Report the active debugger condition, restart list, and top stack frames. Returns 'not in debugger' if no debug level is active.",
    inputSchema: {},
  }, () => {
    const d = session.currentDebug();
    if (!d) return Promise.resolve(txt("not in debugger"));
    const restarts = d.restarts.map((r, i) => `${i}. ${r.name} — ${r.description}`).join("\n");
    const frames = d.frames.map((f) => `#${f.index} ${f.description}`).join("\n");
    return Promise.resolve(txt(
      `level ${d.level} thread ${d.thread}\n` +
        `condition: ${d.condition.type}: ${d.condition.message}\n\n` +
        `restarts:\n${restarts}\n\nframes:\n${frames}`,
    ));
  });

  defTool(server, "debug_invoke_restart", {
    title: "Invoke a restart",
    description: "Invoke restart N (as listed by debug_status).",
    inputSchema: { index: z.number().int().nonnegative() },
  }, async ({ index }) => {
    try {
      const r = await session.debugInvokeRestart(index);
      return txt(format(ctx, "restart", print(r)));
    } catch (e) {
      return err((e as Error).message);
    }
  });

  defTool(server, "debug_abort", {
    title: "Abort to top level",
    description: "Throw to the top-level restart, exiting all debugger levels.",
    inputSchema: {},
  }, async () => {
    try {
      const r = await session.debugAbort();
      return txt(format(ctx, "abort", print(r)));
    } catch (e) {
      return err((e as Error).message);
    }
  });

  defTool(server, "debug_frame_locals", {
    title: "Frame locals",
    description: "Local variables (and catch tags) for the given stack frame.",
    inputSchema: { frame: z.number().int().nonnegative() },
  }, async ({ frame }) => {
    try {
      const r = await session.debugFrameLocals(frame);
      return txt(format(ctx, "frame-locals", print(r)));
    } catch (e) {
      return err((e as Error).message);
    }
  });

  defTool(server, "debug_frame_source", {
    title: "Frame source location",
    description: "Source location for the given stack frame.",
    inputSchema: { frame: z.number().int().nonnegative() },
  }, async ({ frame }) => {
    try {
      const r = await session.debugFrameSource(frame);
      return txt(format(ctx, "frame-source", print(r)));
    } catch (e) {
      return err((e as Error).message);
    }
  });

  defTool(server, "debug_eval_in_frame", {
    title: "Eval in frame",
    description: "Evaluate an expression in the lexical environment of a stack frame.",
    inputSchema: {
      frame: z.number().int().nonnegative(),
      code: z.string(),
    },
  }, async ({ frame, code }) => {
    try {
      return txt(format(ctx, "frame-eval", await session.debugEvalInFrame(frame, code)));
    } catch (e) {
      return err((e as Error).message);
    }
  });

  // ---- handles ----

  defTool(server, "get_handle", {
    title: "Fetch a stored handle",
    description:
      "Retrieve a slice of a previously-stored large result by handle id (returned in '…[truncated … in handle hX]' messages).",
    inputSchema: {
      id: z.string(),
      offset: z.number().int().nonnegative().optional().default(0),
      length: z.number().int().positive().optional(),
    },
  }, ({ id, offset, length }) => {
    const h = ctx.store.get(id);
    if (!h) return Promise.resolve(err(`no such handle: ${id}`));
    const end = length === undefined ? h.data.length : Math.min(h.data.length, offset + length);
    const slice = h.data.slice(offset, end);
    const tail = end < h.data.length ? `\n…[${h.data.length - end} more chars]` : "";
    return Promise.resolve(txt(slice + tail));
  });

  defTool(server, "list_handles", {
    title: "List active handles",
    description: "Show ids and metadata for all stored handles.",
    inputSchema: {},
  }, () => {
    const items = ctx.store.list().map((h) =>
      `${h.id}\t${h.kind}\t${h.data.length}b\t${new Date(h.createdAt).toISOString()}`
    );
    return Promise.resolve(txt(items.join("\n") || "(no handles)"));
  });

  // ---- session info ----

  defTool(server, "connection_info", {
    title: "Slynk connection info",
    description: "Return host Lisp implementation, version, features, and current package.",
    inputSchema: {},
  }, () => {
    const ci = session.connectionInfo;
    if (!ci) return Promise.resolve(err("not connected"));
    return Promise.resolve(txt(
      `pid: ${ci.pid}\n` +
        `lisp: ${ci.lispImplementation.name} ${ci.lispImplementation.version} (${ci.lispImplementation.type})\n` +
        `machine: ${ci.machine.instance} (${ci.machine.type})\n` +
        `package: ${ci.packageName} (prompt: ${ci.prompt})\n` +
        `slynk version: ${ci.version}\n` +
        `features (${ci.features.length}): ${ci.features.slice(0, 30).join(" ")}${
          ci.features.length > 30 ? " …" : ""
        }`,
    ));
  });
}
