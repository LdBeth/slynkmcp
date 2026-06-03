/**
 * Opusmodus plugin — exposes OM-specific helpers as MCP tools.
 *
 * Mirrors the Emacs/SLIME glue Opusmodus ships (`emacs-opusmodus.el`):
 *   - om_audition_snippet → (om:audition-musicxml-omn-snippet '<snippet>)
 *   - om_stop             → (progn (om:stop-midi) (om:stop-sound))
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { asyncSideEffect, asyncStructuredHandler, READ_ONLY } from "../mcp/tool_helpers.ts";
import {
  asList,
  Keyword,
  kw,
  NIL,
  plistEntries,
  print,
  read,
  type Sexp,
  Sym,
  sym,
} from "../slynk/sexp.ts";
import type { Plugin } from "./types.ts";

/** Return the local name of a symbol, stripping the package prefix if present. */
function localName(s: Sexp): string {
  if (s instanceof Sym) {
    const i = s.name.lastIndexOf(":");
    return i >= 0 ? s.name.slice(i + 1) : s.name;
  }
  return print(s);
}

/**
 * Parse the raw Sexp result from `om:function-search` (or the property-values
 * listing) into a structured object suitable for `structuredContent`.
 *
 * No-arg mode returns a plist like `(:category (sym…) :operation (sym…) …)`;
 * filter mode returns a flat list of function-name symbols.
 */
function parseSearchResult(
  r: Sexp,
  fields: readonly string[],
): { properties: Record<string, string[]> } | { functions: string[] } {
  const arr = asList(r, "function-search result");
  if (arr.length > 0 && arr[0] instanceof Keyword) {
    const properties: Record<string, string[]> = {};
    for (const [name, val] of plistEntries(arr)) {
      if ((fields as readonly string[]).includes(name)) {
        properties[name] = asList(val, name).map(localName);
      }
    }
    return { properties };
  }
  return { functions: arr.map(localName) };
}

export const opusmodusPlugin: Plugin = {
  name: "opusmodus",
  instructions: `Opusmodus: 'om_audition_snippet', 'om_stop' plays/stop omn snippet, ` +
    `'om_function_search' search functions.`,
  register(server: McpServer, ctx) {
    const { session } = ctx;

    server.registerTool(
      "om_audition_snippet",
      {
        title: "Audition OMN snippet",
        description: "Audition and display an OMN snippet via Opusmodus. The snippet is " +
          "passed verbatim as a quoted form. " +
          "Example snippet: ((repeat (q c4 e4 g4 c4e4g4) (q a4 g4 g4 c4e4g4))). " +
          "Audible side effects (MIDI playback) and opens MusicXML notation.",
        inputSchema: {
          snippet: z.string().describe(
            "An OMN s-expression as text (will be quoted)",
          ),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      asyncSideEffect(({ snippet }: { snippet: string }) => {
        const form: Sexp = [
          sym("cl:let"),
          [[sym("om::*do-verbose*"), NIL]],
          [sym("om:audition-musicxml-omn-snippet"), [sym("quote"), read(snippet)]],
        ];
        return session.rex(form);
      }),
    );

    server.registerTool(
      "om_stop",
      {
        title: "Stop Opusmodus audition",
        description: "Stop any currently playing Opusmodus audition. " +
          "Idempotent — safe to call when nothing is playing.",
        inputSchema: {},
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      asyncSideEffect(() =>
        session.rex([sym("cl:progn"), [sym("om:stop-midi")], [sym("om:stop-sound")]])
      ),
    );

    const PROPERTY_FIELDS = ["category", "operation", "input", "output", "intent"] as const;
    // Property values from `om:function-property-values` are CL symbol names.
    // Restrict to a conservative subset so we can't synthesize reader errors
    // by interpolating arbitrary user strings into `om::<value>`.
    const PROPERTY_VALUE_RE = /^[A-Za-z0-9*+!?<>=/\-]+$/;

    server.registerTool(
      "om_function_search",
      {
        title: "Search Opusmodus functions",
        description: "Each Opusmodus function carries a " +
          "descriptor (category operation input output intent). Call with NO arguments to list " +
          "the valid symbol values for every property field. Call with one or more filters to " +
          "get the names of functions matching ALL supplied properties. Filter values must be " +
          "valid symbols from the no-argument listing (e.g. category 'filter', operation " +
          "'generate', output 'float', intent 'unison').",
        inputSchema: {
          category: z.string().optional().describe("Function category"),
          operation: z.string().optional().describe("Operation type"),
          input: z.string().optional().describe("Expected input type"),
          output: z.string().optional().describe("Output type"),
          intent: z.string().optional().describe("Conceptual intent"),
        },
        outputSchema: {
          properties: z.object({
            category: z.array(z.string()),
            operation: z.array(z.string()),
            input: z.array(z.string()),
            output: z.array(z.string()),
            intent: z.array(z.string()),
          }).optional().describe(
            "Map of property field names to their valid symbol values " +
              "(returned when called with no arguments)",
          ),
          functions: z.array(z.string()).optional().describe(
            "Matching function names (returned when filters are provided)",
          ),
        },
        annotations: READ_ONLY,
      },
      asyncStructuredHandler(
        ({ category, operation, input, output, intent }) => {
          const args = { category, operation, input, output, intent };
          const provided = PROPERTY_FIELDS.filter((f) => args[f] != null);
          for (const f of provided) {
            const v = args[f]!;
            if (!PROPERTY_VALUE_RE.test(v)) {
              throw new Error(
                `om_function_search: invalid ${f} value ${JSON.stringify(v)} — ` +
                  `expected a symbol name from the no-arg listing`,
              );
            }
          }
          const form: Sexp = provided.length === 0
            ? [
              sym("cl:list"),
              ...PROPERTY_FIELDS.flatMap((f) => [
                kw(f),
                [sym("om:function-property-values"), kw(f)],
              ]),
            ]
            : [
              sym("om:function-search"),
              ...provided.flatMap((f) => [kw(f), [sym("quote"), sym("om::" + args[f])]]),
            ];
          return session.rex(form).then((raw) => {
            return parseSearchResult(raw, PROPERTY_FIELDS);
          });
        },
      ),
    );
  },
};
