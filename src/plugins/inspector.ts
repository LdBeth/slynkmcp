/**
 * Inspector plugin — exposes the Slynk inspector as MCP tools.
 *
 * The inspector is stateful (a stack of inspected objects on the Lisp side),
 * so it's gated behind --plugin=inspector for clients that don't want the
 * extra surface area.
 */

import { z } from "zod";
import { print } from "../slynk/sexp.ts";
import { defAsyncTool, STATEFUL_READ } from "../mcp/tool_helpers.ts";
import type { Plugin } from "./types.ts";

export const inspectorPlugin: Plugin = {
  name: "inspector",
  register(server, ctx) {
    const { session } = ctx;

    defAsyncTool(
      server,
      ctx,
      "lisp_inspect",
      {
        title: "Inspect an expression",
        description: "Open the inspector on the result of an expression. Returns inspector parts.",
        inputSchema: {
          expression: z.string().describe("Lisp expression whose value should be inspected"),
        },
        annotations: STATEFUL_READ,
      },
      "inspect",
      ({ expression }) => session.inspect(expression).then(print),
    );

    defAsyncTool(
      server,
      ctx,
      "lisp_inspect_part",
      {
        title: "Inspect a part",
        description: "Drill into part N of the current inspector view.",
        inputSchema: {
          index: z.number().int().nonnegative().describe(
            "Zero-based index of the part in the current inspector view",
          ),
        },
        annotations: STATEFUL_READ,
      },
      "inspect",
      ({ index }) => session.inspectorPart(index).then(print),
    );

    defAsyncTool(
      server,
      ctx,
      "lisp_inspector_pop",
      {
        title: "Pop inspector",
        description: "Return to the previous inspector level.",
        inputSchema: {},
        annotations: STATEFUL_READ,
      },
      "inspect",
      () => session.inspectorPop().then(print),
    );

    defAsyncTool(
      server,
      ctx,
      "lisp_inspector_reinspect",
      {
        title: "Reinspect current",
        description: "Re-inspect the current object.",
        inputSchema: {},
        annotations: STATEFUL_READ,
      },
      "inspect",
      () => session.inspectorReinspect().then(print),
    );
  },
};
