/**
 * Opusmodus plugin — exposes OM-specific helpers as MCP tools.
 *
 * Mirrors the Emacs/SLIME glue Opusmodus ships (`emacs-opusmodus.el`):
 *   - om_audition_snippet → (om:audition-musicxml-omn-snippet '<snippet>)
 *   - om_stop             → (progn (om:stop-midi) (om:stop-sound))
 */

import { z } from "zod";
import {
  defAsyncTool,
  defTool,
  err,
  formatEvalResult,
  READ_ONLY,
  txt,
} from "../mcp/tool_helpers.ts";
import type { Plugin } from "./types.ts";

export const opusmodusPlugin: Plugin = {
  name: "opusmodus",
  instructions: `Opusmodus: 'om_audition_snippet', 'om_stop' plays/stop omn snippet, ` +
    `'om_function_search' search functions. `,
  register(server, ctx) {
    const { session } = ctx;

    defAsyncTool(
      server,
      ctx,
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
      "eval",
      ({ snippet }) =>
        session.eval(`(om:audition-musicxml-omn-snippet '${snippet})`).then(formatEvalResult),
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
        await session.eval("(progn (om:stop-midi) (om:stop-sound))");
        return txt("stopped");
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
      "eval",
      (args) => {
        const provided = PROPERTY_FIELDS.filter((f) => args[f] != null);
        if (provided.length === 0) {
          const form = `(list ${
            PROPERTY_FIELDS.map((f) => `:${f} (om:function-property-values :${f})`).join(" ")
          })`;
          return session.eval(form).then(formatEvalResult);
        }
        const kwargs = provided.map((f) => `:${f} '${args[f]}`).join(" ");
        return session.eval(`(om:function-search ${kwargs})`).then(formatEvalResult);
      },
    );
  },
};
