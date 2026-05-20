/**
 * Inspector plugin — exposes the Slynk inspector as MCP tools.
 *
 * The inspector is stateful (a stack of inspected objects on the Lisp side),
 * so it's gated behind --plugin=inspector for clients that don't want the
 * extra surface area.
 */

import { z } from "zod";
import { asyncHandler, STATEFUL_READ } from "../mcp/tool_helpers.ts";
import type { Plugin } from "./types.ts";

export const inspectorPlugin: Plugin = {
  name: "inspector",
  instructions: `Inspector: 'lisp_inspect' an object, 'lisp_inspect_part', 'lisp_inspector_pop', ` +
    `'lisp_inspector_reinspect'.`,
  register(server, ctx) {
    const { session } = ctx;

    server.registerTool(
      "lisp_inspect",
      {
        title: "Inspect an expression",
        description: "Open the inspector on the result of an expression. Returns inspector parts.",
        inputSchema: {
          expression: z.string().describe("Lisp expression whose value should be inspected"),
        },
        annotations: STATEFUL_READ,
      },
      asyncHandler(ctx, "inspect", ({ expression }) => session.inspect(expression)),
    );

    server.registerTool(
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
      asyncHandler(ctx, "inspect", ({ index }) => session.inspectorPart(index)),
    );

    server.registerTool(
      "lisp_inspector_pop",
      {
        title: "Pop inspector",
        description: "Return to the previous inspector level.",
        inputSchema: {},
        annotations: STATEFUL_READ,
      },
      asyncHandler(ctx, "inspect", () => session.inspectorPop()),
    );

    server.registerTool(
      "lisp_inspector_reinspect",
      {
        title: "Reinspect current",
        description: "Re-inspect the current object.",
        inputSchema: {},
        annotations: STATEFUL_READ,
      },
      asyncHandler(ctx, "inspect", () => session.inspectorReinspect()),
    );
  },
};
