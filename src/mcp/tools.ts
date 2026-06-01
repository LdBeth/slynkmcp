/**
 * MCP tool definitions. Each tool is registered against the McpServer and
 * delegates to the Session for actual Slynk RPC.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { z } from "zod";
import {
  asyncHandler,
  asyncStructuredHandler,
  type Ctx,
  err,
  MUTATING,
  READ_ONLY,
  txt,
} from "./tool_helpers.ts";
import { asList, isList, Keyword, print, type Sexp, Sym } from "../slynk/sexp.ts";

/** Optional package override accepted by `lisp_eval`, `lisp_completions`, etc. */
const zPackageOverride = z.string().optional().describe(
  "Override the default package for this call",
);

interface AproposItem {
  symbol: string;
  package: string;
  external: boolean;
  type: string;
  documentation: string;
  arglist?: string;
  bounds?: { start: number; end: number };
}

function parseAproposResult(raw: Sexp): AproposItem[] {
  const items = asList(raw, "apropos result");
  return items.map((item) => {
    const plist = asList(item, "apropos entry");
    const result: AproposItem = {
      symbol: "",
      package: "",
      external: false,
      type: "unknown",
      documentation: "",
    };
    for (let i = 0; i < plist.length - 1; i += 2) {
      const key = plist[i];
      if (!(key instanceof Keyword)) continue;
      const val = plist[i + 1];
      switch (key.name) {
        case "designator": {
          const d = asList(val, "designator");
          result.symbol = typeof d[0] === "string" ? d[0] : print(d[0]);
          result.package = typeof d[1] === "string" ? d[1] : print(d[1]);
          result.external = d[2] === true || (d[2] instanceof Sym && d[2].name === "t");
          break;
        }
        case "arglist":
          result.arglist = typeof val === "string" ? val : print(val);
          break;
        case "bounds": {
          const b = asList(val, "bounds");
          if (isList(b[0]) && typeof b[0][0] === "number" && typeof b[0][1] === "number") {
            result.bounds = { start: b[0][0], end: b[0][1] };
          }
          break;
        }
        case "function":
        case "variable":
        case "class":
        case "macro":
          result.type = key.name;
          result.documentation = typeof val === "string"
            ? val
            : val instanceof Keyword && val.name === "not-documented"
            ? ""
            : print(val);
          break;
      }
    }
    return result;
  });
}

export function registerTools(server: McpServer, ctx: Ctx): void {
  const { session } = ctx;

  // ---- core eval ----

  server.registerTool(
    "lisp_eval",
    {
      title: "Evaluate Lisp",
      description: "Evaluate one Common Lisp form in the running image. " +
        "Errors are auto-aborted from the debugger.",
      inputSchema: {
        code: z.string().describe("Lisp source to evaluate"),
        package: zPackageOverride,
      },
      outputSchema: {
        value: z.string().describe("Return value"),
        print: z.string().optional().describe("Captured stdout"),
      },
      annotations: MUTATING,
    },
    asyncStructuredHandler(
      ({ code, package: pkg }) =>
        session.eval(code, pkg) as Promise<{ value: string; print?: string }>,
    ),
  );

  server.registerTool(
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
    asyncHandler(ctx, "compile", ({ path, load }) => session.compileFile(path, load)),
  );

  server.registerTool(
    "lisp_load_file",
    {
      title: "Load a Lisp file",
      description: "LOAD a file in the running image.",
      inputSchema: {
        path: z.string().describe("Absolute path to the file to LOAD"),
      },
      annotations: MUTATING,
    },
    asyncHandler(ctx, "load", ({ path }) => session.loadFile(path)),
  );

  server.registerTool("lisp_interrupt", {
    title: "Interrupt running computation",
    description: "Send :emacs-interrupt to the REPL thread.",
    inputSchema: {},
    annotations: MUTATING,
  }, () => {
    session.interrupt();
    return txt("interrupt sent");
  });

  // ---- introspection ----

  server.registerTool(
    "lisp_completions",
    {
      title: "Symbol completions",
      description: "Flex-style symbol completions for a prefix.",
      inputSchema: {
        prefix: z.string().describe("Symbol prefix to complete"),
        package: zPackageOverride,
      },
      annotations: READ_ONLY,
    },
    asyncHandler(
      ctx,
      "completions",
      ({ prefix, package: pkg }) => session.completions(prefix, pkg).then((s) => s.join("\n")),
    ),
  );

  server.registerTool(
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
      outputSchema: {
        results: z.array(z.object({
          symbol: z.string(),
          package: z.string(),
          external: z.boolean(),
          type: z.string(),
          documentation: z.string(),
          arglist: z.string().optional(),
          bounds: z.object({ start: z.number(), end: z.number() }).optional(),
        })),
      },
      annotations: READ_ONLY,
    },
    asyncStructuredHandler(
      ({ pattern, externalOnly }) =>
        session.aproposRaw(pattern, externalOnly).then((raw) => {
          return { results: parseAproposResult(raw) };
        }),
    ),
  );

  server.registerTool(
    "lisp_describe_symbol",
    {
      title: "Describe a symbol",
      description: "Full describe output for a symbol (function/variable/class).",
      inputSchema: {
        symbol: z.string().describe("Symbol name to describe (e.g. 'mapcar', 'cl:list')"),
      },
      annotations: READ_ONLY,
    },
    asyncHandler(ctx, "describe", ({ symbol }) => session.describe(symbol)),
  );

  server.registerTool(
    "lisp_documentation",
    {
      title: "Symbol docstring",
      description: "DOCUMENTATION string for a symbol.",
      inputSchema: {
        symbol: z.string().describe("Symbol name to fetch the docstring for"),
      },
      annotations: READ_ONLY,
    },
    asyncHandler(ctx, "doc", ({ symbol }) => session.documentation(symbol)),
  );

  server.registerTool(
    "lisp_arglist",
    {
      title: "Operator arglist",
      description: "Argument list for a function/macro.",
      inputSchema: {
        symbol: z.string().describe("Function or macro name"),
      },
      annotations: READ_ONLY,
    },
    asyncHandler(ctx, "arglist", ({ symbol }) => session.arglist(symbol)),
  );

  server.registerTool(
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
    asyncHandler(ctx, "macroexpand", ({ form, all }) => session.macroexpand(form, all)),
  );

  server.registerTool(
    "lisp_find_definition",
    {
      title: "Find symbol definition",
      description: "Source locations for a symbol's definitions.",
      inputSchema: {
        symbol: z.string().describe("Symbol name whose definitions to locate"),
      },
      annotations: READ_ONLY,
    },
    asyncHandler(ctx, "find-def", ({ symbol }) => session.findDefinition(symbol)),
  );

  // ---- handles ----

  server.registerTool("lisp_get_handle", {
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

  server.registerTool("lisp_list_handles", {
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

  server.registerTool("lisp_set_package", {
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

  server.registerTool(
    "lisp_connection_info",
    {
      title: "Slynk connection info",
      description: "Return host Lisp implementation, version, features, and current package.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    asyncHandler(
      ctx,
      "connection-info",
      () =>
        session.getConnectionInfo().then((ci) =>
          `pid: ${ci.pid}\n` +
          `lisp: ${ci.lisp.name} ${ci.lisp.version} ` +
          `(${ci.lisp.type})\n` +
          `machine: ${ci.machine.instance} (${ci.machine.type})\n` +
          `package: ${session.defaultPackage} (initial: ${ci.packageName}, prompt: ${ci.prompt})\n` +
          /* `slynk version: ${ci.version}\n` + */
          `features (${ci.features.length}): ${ci.features.slice(0, 30).join(" ")}${
            ci.features.length > 30 ? " …" : ""
          }`
        ),
    ),
  );
}
