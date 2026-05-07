# Opusmodus Plugin — Design

**Date:** 2026-05-07
**Status:** Approved, ready for implementation plan

## Motivation

The Slynk bridge in swankmcp is intentionally generic: it exposes Lisp evaluation,
arglist, apropos, inspector, and debugger over MCP, and works against any Slynk
server. Opusmodus (OM) is a Common Lisp application loaded into LispWorks that adds
algorithmic-composition primitives, OMN notation, and audition (MIDI / score
preview) functions.

The Emacs/SLIME glue Opusmodus ships (`emacs-opusmodus.el`) demonstrates the OM
helpers a user typically reaches for: `audition-musicxml-omn-snippet`,
`audition-musicxml-voices-snippet`, `audition-musicxml-last-score`, and a stop
helper that calls `om:stop-midi` + `om:stop-sound`. We want the equivalent surface
exposed as MCP tools so the model can audition snippets directly.

We don't want OM-specific tools to live in `src/mcp/tools.ts` next to the core
Lisp tools — the bridge stays useful against non-OM Slynk targets. Instead, an
in-tree plugin seam lets OM tools be registered as a separate module, activated
explicitly per run.

## Goals

- Keep `src/mcp/tools.ts` Lisp-agnostic.
- Provide a small plugin seam (single in-tree project, no third-party loading).
- Ship one Opusmodus plugin with two tools: `om_audition_snippet` and `om_stop`.
- Activation is explicit and predictable (CLI/env flag), no auto-detection.

## Non-Goals

- Third-party / out-of-tree plugin loading.
- Auto-detection of the running Lisp environment.
- Full coverage of the Emacs OM glue (voices snippet, last-score) — these can be
  added later without changing the seam.
- Plugin-level event hooks, lifecycle callbacks, or shared state beyond
  `(server, session)`.

## Architecture

### Plugin seam

A plugin is a TypeScript module exporting an object that conforms to:

```ts
// src/plugins/types.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Session } from "../session.ts";

export interface Plugin {
  name: string;
  register(server: McpServer, session: Session): void;
}
```

`register()` is called once at startup, after core tools are wired. It uses the
same `defTool`-style registration that `src/mcp/tools.ts` uses today, so plugins
inherit the existing Zod-4 / MCP-SDK workaround.

### Registry

`src/plugins/registry.ts` is a hard-coded name → module map:

```ts
import { opusmodusPlugin } from "./opusmodus.ts";

export const PLUGINS: Record<string, Plugin> = {
  opusmodus: opusmodusPlugin,
};
```

The registry exposes a `loadPlugins(names: string[]): Plugin[]` that resolves
names against `PLUGINS`. Unknown names throw with a message listing known
plugins. Each plugin is loaded at most once even if its name is passed twice.

### Wiring in `main.ts`

`main.ts` parses plugin names from:

- `--plugin=<name>` (repeatable CLI flag), and
- `SWANKMCP_PLUGINS` env var (comma-separated).

The two sources are concatenated and de-duplicated. Resolution happens before the
MCP server starts serving. Failure to resolve any name aborts startup with a
non-zero exit and the list of known plugin names. Resolved plugins have
`register()` called after the core tool set is registered.

### Layout

```
src/plugins/
  types.ts          # Plugin interface
  registry.ts       # name -> Plugin map, loadPlugins()
  opusmodus.ts      # the OM plugin
  registry_test.ts  # unit test for resolution / errors
```

`src/mcp/tools.ts` is unchanged.

## Opusmodus plugin

Both tools are thin wrappers over `session.eval`. They reuse the existing
output-capture mutex and handle-truncation paths automatically — no new session
APIs are needed.

Tool names use the `om_` prefix, mirroring the existing `lisp_*` convention.

### `om_audition_snippet`

- **Input:** `{ snippet: string }` — an OMN expression. Example:
  `((repeat (q c4 e4 g4 c4e4g4) (q a4 g4 g4 c4e4g4)))`.
- **Eval:** `(om:audition-musicxml-omn-snippet '<snippet>)` (snippet inserted
  verbatim — the user is responsible for valid OMN s-expression text).
- **Annotations:** `readOnlyHint: false` (audible side effects + opens
  notation), `destructiveHint: false`.
- **Output:** the standard `lisp_eval` result shape — `result`, `output`, and
  optional handle for large output.

### `om_stop`

- **Input:** none.
- **Eval:** `(progn (om:stop-midi) (om:stop-sound))`.
- **Annotations:** `readOnlyHint: false`, `idempotentHint: true`.
- **Output:** standard eval result.

### Error handling

No plugin-specific error handling. If OM isn't loaded in the connected image,
Slynk returns an unbound-symbol error for `om:*`, which surfaces as the normal
eval error to the model. The user is expected to only pass `--plugin=opusmodus`
when actually connected to Opusmodus.

## Testing

- **`registry_test.ts`** (unit): `loadPlugins(["opusmodus"])` returns the OM
  plugin once; passing the name twice still returns it once; unknown name throws
  with a message containing the known names.
- **OM tools:** require a running Opusmodus image. Manual smoke test documented
  in README — start swankmcp with `--plugin=opusmodus` against a live OM Slynk,
  call `om_audition_snippet` with the example OMN, then `om_stop`.

## Out of scope (future, no design changes needed)

- `om_audition_voices` (wraps `om::audition-musicxml-voices-snippet`).
- `om_audition_last_score` (wraps `om::audition-musicxml-last-score`).
- Auto-detection via `slynk:connection-info` package list.
- Third-party plugin loading from a directory.
