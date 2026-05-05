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

/**
 * Register an async tool whose handler follows the standard pattern:
 *
 *   try { op(args) → format → +debugSummary → txt }
 *   catch (e) { (e.message + debugSummary) → err }
 *
 * By the Either monad this is
 *   mapRight (txt . appendDbg) . mapLeft (err . appendDbg) (toEither (op(args)))
 *
 * Parameterised as a factory to eliminate the repeated try/catch stanzas
 * (used 19 times — every async tool except the five sync special cases).
 */
function defAsyncTool<S extends z.ZodRawShape>(
  server: McpServer,
  ctx: Ctx,
  name: string,
  config: { title?: string; description: string; inputSchema: S },
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

export function registerTools(server: McpServer, ctx: Ctx): void {
  const { session } = ctx;

  // ---- core eval ----

  defAsyncTool(
    server,
    ctx,
    "eval",
    {
      title: "Evaluate Lisp",
      description:
        "Evaluate a Common Lisp expression in the running image. Returns the printed value plus any captured stdout. Defaults to the configured Opusmodus package.",
      inputSchema: {
        code: z.string().describe("Lisp source to evaluate"),
        package: z.string().optional().describe("Override the default package"),
      },
    },
    "eval",
    ({ code, package: pkg }) =>
      session.listenerEval(code, pkg).then((r) =>
        (r.output ? `[stdout]\n${r.output}\n[value]\n` : "") + r.value
      ),
  );

  defAsyncTool(
    server,
    ctx,
    "compile_file",
    {
      title: "Compile a Lisp file",
      description:
        "Compile a file via slynk:compile-file-for-emacs. Optionally load the resulting fasl.",
      inputSchema: {
        path: z.string().describe("Absolute path to the .lisp file"),
        load: z.boolean().optional().default(true),
      },
    },
    "compile",
    ({ path, load }) => session.compileFile(path, load).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "load_file",
    {
      title: "Load a Lisp file",
      description: "LOAD a file in the running image.",
      inputSchema: { path: z.string() },
    },
    "load",
    ({ path }) => session.loadFile(path).then(print),
  );

  defTool(server, "interrupt", {
    title: "Interrupt running computation",
    description: "Send :emacs-interrupt to the REPL thread.",
    inputSchema: {},
  }, () => {
    session.interrupt();
    return txt("interrupt sent");
  });

  // ---- introspection ----

  defAsyncTool(
    server,
    ctx,
    "completions",
    {
      title: "Symbol completions",
      description: "Flex-style symbol completions for a prefix.",
      inputSchema: { prefix: z.string(), package: z.string().optional() },
    },
    "completions",
    ({ prefix, package: pkg }) => (session.completions(prefix, pkg)).then((s) => s.join("\n")),
  );

  defAsyncTool(
    server,
    ctx,
    "apropos",
    {
      title: "Apropos search",
      description: "Search for symbols matching a substring.",
      inputSchema: {
        pattern: z.string(),
        externalOnly: z.boolean().optional().default(true),
      },
    },
    "apropos",
    ({ pattern, externalOnly }) => session.apropos(pattern, externalOnly),
  );

  defAsyncTool(
    server,
    ctx,
    "describe_symbol",
    {
      title: "Describe a symbol",
      description: "Full describe output for a symbol (function/variable/class).",
      inputSchema: { symbol: z.string() },
    },
    "describe",
    ({ symbol }) => session.describe(symbol),
  );

  defAsyncTool(
    server,
    ctx,
    "documentation",
    {
      title: "Symbol docstring",
      description: "DOCUMENTATION string for a symbol.",
      inputSchema: { symbol: z.string() },
    },
    "doc",
    ({ symbol }) => session.documentation(symbol),
  );

  defAsyncTool(
    server,
    ctx,
    "arglist",
    {
      title: "Operator arglist",
      description: "Argument list for a function/macro.",
      inputSchema: { symbol: z.string() },
    },
    "arglist",
    ({ symbol }) => session.arglist(symbol),
  );

  defAsyncTool(
    server,
    ctx,
    "macroexpand",
    {
      title: "Macro-expand a form",
      description: "Macroexpand-1 by default, or fully expand all macros.",
      inputSchema: {
        form: z.string(),
        all: z.boolean().optional().default(false),
      },
    },
    "macroexpand",
    ({ form, all }) => session.macroexpand(form, all),
  );

  defAsyncTool(
    server,
    ctx,
    "find_definition",
    {
      title: "Find symbol definition",
      description: "Source locations for a symbol's definitions.",
      inputSchema: { symbol: z.string() },
    },
    "find-def",
    ({ symbol }) => session.findDefinition(symbol).then(print),
  );

  // ---- inspector ----

  defAsyncTool(
    server,
    ctx,
    "inspect",
    {
      title: "Inspect an expression",
      description: "Open the inspector on the result of an expression. Returns inspector parts.",
      inputSchema: { expression: z.string() },
    },
    "inspect",
    ({ expression }) => session.inspect(expression).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "inspect_part",
    {
      title: "Inspect a part",
      description: "Drill into part N of the current inspector view.",
      inputSchema: { index: z.number().int().nonnegative() },
    },
    "inspect",
    ({ index }) => session.inspectorPart(index).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "inspector_pop",
    {
      title: "Pop inspector",
      description: "Return to the previous inspector level.",
      inputSchema: {},
    },
    "inspect",
    () => session.inspectorPop().then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "inspector_reinspect",
    {
      title: "Reinspect current",
      description: "Re-inspect the current object.",
      inputSchema: {},
    },
    "inspect",
    () => session.inspectorReinspect().then(print),
  );

  // ---- debugger ----

  defTool(server, "debug_status", {
    title: "Current debugger state",
    description:
      "Report the active debugger condition, restart list, and top stack frames. Returns 'not in debugger' if no debug level is active.",
    inputSchema: {},
  }, () => {
    const d = session.currentDebug();
    if (!d) return txt("not in debugger");
    const restarts = d.restarts.map((r, i) => `${i}. ${r.name} — ${r.description}`).join("\n");
    const frames = d.frames.map((f) => `#${f.index} ${f.description}`).join("\n");
    return txt(
      `level ${d.level} thread ${d.thread}\n` +
        `condition: ${d.condition.type}: ${d.condition.message}\n\n` +
        `restarts:\n${restarts}\n\nframes:\n${frames}`,
    );
  });

  defAsyncTool(
    server,
    ctx,
    "debug_invoke_restart",
    {
      title: "Invoke a restart",
      description: "Invoke restart N (as listed by debug_status).",
      inputSchema: { index: z.number().int().nonnegative() },
    },
    "restart",
    ({ index }) => session.debugInvokeRestart(index).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "debug_abort",
    {
      title: "Abort to top level",
      description: "Throw to the top-level restart, exiting all debugger levels.",
      inputSchema: {},
    },
    "abort",
    () => session.debugAbort().then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "debug_frame_locals",
    {
      title: "Frame locals",
      description: "Local variables (and catch tags) for the given stack frame.",
      inputSchema: { frame: z.number().int().nonnegative() },
    },
    "frame-locals",
    ({ frame }) => session.debugFrameLocals(frame).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "debug_frame_source",
    {
      title: "Frame source location",
      description: "Source location for the given stack frame.",
      inputSchema: { frame: z.number().int().nonnegative() },
    },
    "frame-source",
    ({ frame }) => session.debugFrameSource(frame).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "debug_eval_in_frame",
    {
      title: "Eval in frame",
      description: "Evaluate an expression in the lexical environment of a stack frame.",
      inputSchema: {
        frame: z.number().int().nonnegative(),
        code: z.string(),
      },
    },
    "frame-eval",
    ({ frame, code }) => session.debugEvalInFrame(frame, code),
  );

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
    if (!h) return err(`no such handle: ${id}`);
    const end = length === undefined ? h.data.length : Math.min(h.data.length, offset + length);
    const slice = h.data.slice(offset, end);
    const tail = end < h.data.length ? `\n…[${h.data.length - end} more chars]` : "";
    return txt(slice + tail);
  });

  defTool(server, "list_handles", {
    title: "List active handles",
    description: "Show ids and metadata for all stored handles.",
    inputSchema: {},
  }, () => {
    const items = ctx.store.list().map((h) =>
      `${h.id}\t${h.kind}\t${h.data.length}b\t${new Date(h.createdAt).toISOString()}`
    );
    return txt(items.join("\n") || "(no handles)");
  });

  // ---- session info ----

  defTool(server, "set_package", {
    title: "Set current package",
    description: "Set the default package used by eval, completions, and all other tools. " +
      "Equivalent to CL:IN-PACKAGE but handled client-side — no RPC is sent.",
    inputSchema: {
      package: z.string().describe('Package name (e.g. "cl-user", "om")'),
    },
  }, ({ package: pkg }) => {
    session.defaultPackage = pkg;
    return txt(`default package set to ${pkg}`);
  });

  defTool(server, "connection_info", {
    title: "Slynk connection info",
    description: "Return host Lisp implementation, version, features, and current package.",
    inputSchema: {},
  }, () => {
    const ci = session.connectionInfo;
    if (!ci) return err("not connected");
    return txt(
      `pid: ${ci.pid}\n` +
        `lisp: ${ci.lispImplementation.name} ${ci.lispImplementation.version} (${ci.lispImplementation.type})\n` +
        `machine: ${ci.machine.instance} (${ci.machine.type})\n` +
        `package: ${session.defaultPackage} (initial: ${ci.packageName}, prompt: ${ci.prompt})\n` +
        `slynk version: ${ci.version}\n` +
        `features (${ci.features.length}): ${ci.features.slice(0, 30).join(" ")}${
          ci.features.length > 30 ? " …" : ""
        }`,
    );
  });
}
