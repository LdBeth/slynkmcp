/**
 * Opusmodus plugin — exposes OM-specific helpers as MCP tools.
 *
 * Mirrors the Emacs/SLIME glue Opusmodus ships (`emacs-opusmodus.el`):
 *   - om_audition_snippet → (om:audition-musicxml-omn-snippet '<snippet>)
 *   - om_stop             → (progn (om:stop-midi) (om:stop-sound))
 */

import { z } from "zod";
import { defAsyncTool, defTool, err, READ_ONLY } from "../mcp/tool_helpers.ts";
import { Cons, kw, NIL, print, read, type Sexp, Sym, sym } from "../slynk/sexp.ts";
import type { Plugin } from "./types.ts";

/**
 * Walk a result s-expr and strip the package prefix from every symbol name,
 * leaving only the local part (`opusmodus:filter` → `filter`,
 * `common-lisp::sort` → `sort`). Slynk prints symbols qualified relative to
 * the rex thread's `*package*`, so `om:function-search` results arrive full of
 * `opusmodus:`/`common-lisp:` noise the model does not need. Keywords are left
 * intact — they are the plist field names (`:category`, `:output`, …).
 */
function stripPackages(s: Sexp): Sexp {
  if (s instanceof Sym) {
    const i = s.name.lastIndexOf(":");
    return i >= 0 ? sym(s.name.slice(i + 1)) : s;
  }
  if (s instanceof Cons) return new Cons(stripPackages(s.car), stripPackages(s.cdr));
  if (Array.isArray(s)) return s.map(stripPackages);
  return s;
}

export const opusmodusPlugin: Plugin = {
  name: "opusmodus",
  instructions: `Opusmodus: 'om_audition_snippet', 'om_stop' plays/stop omn snippet, ` +
    `'om_function_search' search functions. `,
  register(server, ctx) {
    const { session } = ctx;

    defTool(
      server,
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

    defTool(server, "om_stop", {
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

    defAsyncTool(
      server,
      ctx,
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
        annotations: READ_ONLY,
      },
      "search",
      (args) => {
        const provided = PROPERTY_FIELDS.filter((f) => args[f] != null);
        // Build the query as an s-expr and dispatch via rex — no string round-trip
        // through interactive-eval, and no captured-output wrapper.
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
            // Qualify filter values into the `om` package explicitly. The
            // descriptor values returned by `om:function-property-values` are
            // `om`-package symbols; sending a bare symbol would intern it in
            // whatever `session.defaultPackage` happens to be, so it would not
            // be `eq` to the stored values and the search would match nothing.
            ...provided.flatMap((f) => [kw(f), [sym("quote"), sym("om::" + args[f])]]),
          ];
        return session.rex(form).then((r) => print(stripPackages(r)));
      },
    );
  },
};
