/**
 * MCP tool definitions. Each tool is registered against the McpServer and
 * delegates to the Session for actual Slynk RPC.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { print } from "../slynk/sexp.ts";
import {
  type Ctx,
  defAsyncTool,
  defTool,
  err,
  formatEvalResult,
  MUTATING,
  READ_ONLY,
  txt,
} from "./tool_helpers.ts";

export type { Ctx };

export function registerTools(server: McpServer, ctx: Ctx): void {
  const { session } = ctx;

  // ---- core eval ----

  defAsyncTool(
    server,
    ctx,
    "lisp_eval",
    {
      title: "Evaluate Lisp",
      description: "Evaluate a Common Lisp expression in the running image. " +
        "Returns the printed value plus any captured stdout.",
      inputSchema: {
        code: z.string().describe("Lisp source to evaluate"),
        package: z.string().optional().describe("Override the default package for this call"),
      },
      annotations: MUTATING,
    },
    "eval",
    ({ code, package: pkg }) => session.eval(code, pkg).then(formatEvalResult),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_compile_file",
    {
      title: "Compile a Lisp file",
      description: "Compile a file. Optionally load the resulting fasl.",
      inputSchema: {
        path: z.string().describe("Absolute path to the .lisp file"),
        load: z.boolean().optional().default(true).describe(
          "Load the resulting fasl after a successful compile (default true)",
        ),
      },
      annotations: MUTATING,
    },
    "compile",
    ({ path, load }) => session.compileFile(path, load).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_load_file",
    {
      title: "Load a Lisp file",
      description: "LOAD a file in the running image.",
      inputSchema: {
        path: z.string().describe("Absolute path to the file to LOAD"),
      },
      annotations: MUTATING,
    },
    "load",
    ({ path }) => session.loadFile(path).then(print),
  );

  defTool(server, "lisp_interrupt", {
    title: "Interrupt running computation",
    description: "Send :emacs-interrupt to the REPL thread.",
    inputSchema: {},
    annotations: MUTATING,
  }, () => {
    session.interrupt();
    return txt("interrupt sent");
  });

  // ---- introspection ----

  defAsyncTool(
    server,
    ctx,
    "lisp_completions",
    {
      title: "Symbol completions",
      description: "Flex-style symbol completions for a prefix.",
      inputSchema: {
        prefix: z.string().describe("Symbol prefix to complete"),
        package: z.string().optional().describe("Package context for completion"),
      },
      annotations: READ_ONLY,
    },
    "completions",
    ({ prefix, package: pkg }) => (session.completions(prefix, pkg)).then((s) => s.join("\n")),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_apropos",
    {
      title: "Apropos search",
      description: "Search for symbols matching a substring.",
      inputSchema: {
        pattern: z.string().describe("Substring or pattern to match against symbol names"),
        externalOnly: z.boolean().optional().default(true).describe(
          "Restrict to external (exported) symbols only (default true)",
        ),
      },
      annotations: READ_ONLY,
    },
    "apropos",
    ({ pattern, externalOnly }) => session.apropos(pattern, externalOnly),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_describe_symbol",
    {
      title: "Describe a symbol",
      description: "Full describe output for a symbol (function/variable/class).",
      inputSchema: {
        symbol: z.string().describe("Symbol name to describe (e.g. 'mapcar', 'cl:list')"),
      },
      annotations: READ_ONLY,
    },
    "describe",
    ({ symbol }) => session.describe(symbol),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_documentation",
    {
      title: "Symbol docstring",
      description: "DOCUMENTATION string for a symbol.",
      inputSchema: {
        symbol: z.string().describe("Symbol name to fetch the docstring for"),
      },
      annotations: READ_ONLY,
    },
    "doc",
    ({ symbol }) => session.documentation(symbol),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_arglist",
    {
      title: "Operator arglist",
      description: "Argument list for a function/macro.",
      inputSchema: {
        symbol: z.string().describe("Function or macro name"),
      },
      annotations: READ_ONLY,
    },
    "arglist",
    ({ symbol }) => session.arglist(symbol),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_macroexpand",
    {
      title: "Macro-expand a form",
      description: "Macroexpand-1 by default, or fully expand all macros.",
      inputSchema: {
        form: z.string().describe("Source form string to expand"),
        all: z.boolean().optional().default(false).describe(
          "If true, fully expand all macros (macroexpand-all); otherwise macroexpand-1",
        ),
      },
      annotations: READ_ONLY,
    },
    "macroexpand",
    ({ form, all }) => session.macroexpand(form, all),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_find_definition",
    {
      title: "Find symbol definition",
      description: "Source locations for a symbol's definitions.",
      inputSchema: {
        symbol: z.string().describe("Symbol name whose definitions to locate"),
      },
      annotations: READ_ONLY,
    },
    "find-def",
    ({ symbol }) => session.findDefinition(symbol).then(print),
  );

  // ---- debugger ----

  defTool(server, "lisp_debug_status", {
    title: "Current debugger state",
    description: "Report the active debugger condition, restart list, and top stack frames. " +
      "Returns 'not in debugger' if no debug level is active.",
    inputSchema: {},
    annotations: READ_ONLY,
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
    "lisp_debug_invoke_restart",
    {
      title: "Invoke a restart",
      description: "Invoke restart N (as listed by lisp_debug_status).",
      inputSchema: {
        index: z.number().int().nonnegative().describe(
          "Zero-based index into the restart list shown by lisp_debug_status",
        ),
      },
      annotations: MUTATING,
    },
    "restart",
    ({ index }) => session.debugInvokeRestart(index).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_debug_abort",
    {
      title: "Abort to top level",
      description: "Throw to the top-level restart, exiting all debugger levels.",
      inputSchema: {},
      annotations: MUTATING,
    },
    "abort",
    () => session.debugAbort().then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_debug_frame_locals",
    {
      title: "Frame locals",
      description: "Local variables (and catch tags) for the given stack frame.",
      inputSchema: {
        frame: z.number().int().nonnegative().describe("Zero-based stack frame index"),
      },
      annotations: READ_ONLY,
    },
    "frame-locals",
    ({ frame }) => session.debugFrameLocals(frame).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_debug_frame_source",
    {
      title: "Frame source location",
      description: "Source location for the given stack frame.",
      inputSchema: {
        frame: z.number().int().nonnegative().describe("Zero-based stack frame index"),
      },
      annotations: READ_ONLY,
    },
    "frame-source",
    ({ frame }) => session.debugFrameSource(frame).then(print),
  );

  defAsyncTool(
    server,
    ctx,
    "lisp_debug_eval_in_frame",
    {
      title: "Eval in frame",
      description: "Evaluate an expression in the lexical environment of a stack frame.",
      inputSchema: {
        frame: z.number().int().nonnegative().describe("Zero-based stack frame index"),
        code: z.string().describe("Lisp expression to evaluate in that frame's environment"),
      },
      annotations: MUTATING,
    },
    "frame-eval",
    ({ frame, code }) => session.debugEvalInFrame(frame, code),
  );

  // ---- handles ----

  defTool(server, "lisp_get_handle", {
    title: "Fetch a stored handle",
    description:
      "Retrieve previously-stored large result by handle id (returned in '…[truncated … in handle hX]' messages).",
    inputSchema: {
      id: z.string().describe("Handle id (e.g. 'h3') from a prior truncation message"),
      offset: z.number().int().nonnegative().optional().default(0).describe(
        "Starting character offset within the stored payload (default 0)",
      ),
      length: z.number().int().positive().optional().describe(
        "Maximum characters to return; omitted means read to end",
      ),
    },
    annotations: READ_ONLY,
  }, ({ id, offset, length }) => {
    const h = session.getHandle(id);
    if (!h) return err(`no such handle: ${id}`);
    const end = length === undefined ? h.data.length : Math.min(h.data.length, offset + length);
    const slice = h.data.slice(offset, end);
    const tail = end < h.data.length ? `\n…[${h.data.length - end} more chars]` : "";
    return txt(slice + tail);
  });

  defTool(server, "lisp_list_handles", {
    title: "List active handles",
    description: "Show ids and metadata for all stored handles.",
    inputSchema: {},
    annotations: READ_ONLY,
  }, () => {
    const items = session.listHandles().map((h) =>
      `${h.id}\t${h.kind}\t${h.data.length}b\t${new Date(h.createdAt).toISOString()}`
    );
    return txt(items.join("\n") || "(no handles)");
  });

  // ---- session info ----

  defTool(server, "lisp_set_package", {
    title: "Set current package",
    description: "Set the default package used by eval, completions, and all other tools. " +
      "Equivalent to CL:IN-PACKAGE but handled client-side — no RPC is sent.",
    inputSchema: {
      package: z.string().describe('Package name (e.g. "cl-user", "om")'),
    },
    annotations: MUTATING,
  }, ({ package: pkg }) => {
    session.defaultPackage = pkg;
    return txt(`default package set to ${pkg}`);
  });

  defAsyncTool(
    server,
    ctx,
    "lisp_connection_info",
    {
      title: "Slynk connection info",
      description: "Return host Lisp implementation, version, features, and current package.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    "connection-info",
    () =>
      session.getConnectionInfo().then((ci) =>
        `pid: ${ci.pid}\n` +
        `lisp: ${ci.lisp.name} ${ci.lisp.version} ` +
        `(${ci.lisp.type})\n` +
        `machine: ${ci.machine.instance} (${ci.machine.type})\n` +
        `package: ${session.defaultPackage} (initial: ${ci.packageName}, prompt: ${ci.prompt})\n` +
        `slynk version: ${ci.version}\n` +
        `features (${ci.features.length}): ${ci.features.slice(0, 30).join(" ")}${
          ci.features.length > 30 ? " …" : ""
        }`
      ),
  );
}
