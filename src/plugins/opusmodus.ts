/**
 * Opusmodus plugin — exposes OM-specific helpers as MCP tools.
 *
 * Mirrors the Emacs/SLIME glue Opusmodus ships (`emacs-opusmodus.el`):
 *   - om_audition_snippet → (om:audition-musicxml-omn-snippet '<snippet>)
 *   - om_stop             → (progn (om:stop-midi) (om:stop-sound))
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { err, READ_ONLY } from "../mcp/tool_helpers.ts";
import { asList, Keyword, kw, NIL, print, read, type Sexp, Sym, sym } from "../slynk/sexp.ts";
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
    for (let i = 0; i < arr.length - 1; i += 2) {
      const key = arr[i];
      if (key instanceof Keyword && (fields as readonly string[]).includes(key.name)) {
        properties[key.name] = asList(arr[i + 1], key.name).map(localName);
      }
    }
    return { properties };
  }
  return { functions: arr.map(localName) };
}

export const opusmodusPlugin: Plugin = {
  name: "opusmodus",
  instructions: `Opusmodus: 'om_audition_snippet', 'om_stop' plays/stop omn snippet, ` +
    `'om_function_search' search functions. `,
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
      async ({ snippet }) => {
        // rex evaluates the form directly, bypassing the `session.eval` verbose
        // wrapper above — so re-apply the (om::*do-verbose* nil) binding here.
        // The snippet is parsed into an s-expr and quoted as the call argument.
        try {
          const form: Sexp = [
            sym("cl:let"),
            [[sym("om::*do-verbose*"), NIL]],
            [sym("om:audition-musicxml-omn-snippet"), [sym("quote"), read(snippet)]],
          ];
          await session.rex(form);
          // Success is silent — audition is a side effect, there is no value.
          return { content: [] };
        } catch (e) {
          return err((e as Error).message);
        }
      },
    );

    server.registerTool("om_stop", {
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
    }, async () => {
      try {
        await session.rex([sym("cl:progn"), [sym("om:stop-midi")], [sym("om:stop-sound")]]);
        // Success is silent — stopping is a side effect, there is no value.
        return { content: [] };
      } catch (e) {
        return err((e as Error).message);
      }
    });

    const PROPERTY_FIELDS = ["category", "operation", "input", "output", "intent"] as const;

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
      async ({ category, operation, input, output, intent }) => {
        const args = { category, operation, input, output, intent };
        const provided = PROPERTY_FIELDS.filter((f) => args[f] != null);
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
        try {
          const raw = await session.rex(form);
          const structured = parseSearchResult(raw, PROPERTY_FIELDS);
          return {
            content: [],
            structuredContent: structured as Record<string, unknown>,
          };
        } catch (e) {
          return err((e as Error).message);
        }
      },
    );
  },
};
