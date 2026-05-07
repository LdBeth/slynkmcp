/**
 * Opusmodus plugin — exposes OM-specific helpers as MCP tools.
 *
 * Mirrors the Emacs/SLIME glue Opusmodus ships (`emacs-opusmodus.el`):
 *   - om_audition_snippet → (om:audition-musicxml-omn-snippet '<snippet>)
 *   - om_stop             → (progn (om:stop-midi) (om:stop-sound))
 */

import { z } from "zod";
import { defAsyncTool, defTool, err, txt } from "../mcp/tool_helpers.ts";
import type { Plugin } from "./types.ts";

export const opusmodusPlugin: Plugin = {
  name: "opusmodus",
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
        session.eval(`(om:audition-musicxml-omn-snippet '${snippet})`).then((r) =>
          (r.output ? `[stdout]\n${r.output}\n[value]\n` : "") + r.value
        ),
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
  },
};
