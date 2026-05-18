# swankmcp

MCP server bridging Claude Code to a running Lisp image (e.g. Opusmodus) via the Slynk protocol.

## Architecture

```
Claude Code  ──stdio MCP──▶  swankmcp (Deno)  ──TCP──▶  Slynk :4005  ──▶  Opusmodus / LispWorks
```

A single long-lived TCP connection to Slynk multiplexes all MCP tool calls; the connection and a
dedicated mREPL channel are opened lazily on the first tool call (see Lifecycle below). Per-request
stdout is captured via the mREPL channel. When an error from `lisp_eval` drops into the Slynk
debugger the call suspends rather than failing: the tool result describes the condition, restarts,
and frames, and the `lisp_debug_*` tools let the model query frames, eval in frames, and invoke a
restart (or abort). Errors from every other tool are auto-aborted and surfaced as MCP tool errors.

## Lifecycle

The TCP connection to Slynk is opened **lazily on the first tool call**, not at MCP server startup.
This means swankmcp can be configured into Claude Desktop / Claude Code permanently — if Opusmodus
isn't running yet, the MCP server still comes up cleanly and tool calls return a clear error message
("Slynk not reachable on host:port — start the Lisp image and run
`(slynk:create-server :port N :dont-close t)`") until the Lisp image is available. If Opusmodus
restarts mid-session, swankmcp drops its cached state and the next tool call transparently
reconnects.

## Configuration

Environment variables:

| Var                | Default     | Purpose                                  |
| ------------------ | ----------- | ---------------------------------------- |
| `SLYNK_HOST`       | `127.0.0.1` | Slynk listener host                      |
| `SLYNK_PORT`       | `4005`      | Slynk listener port                      |
| `CL_PACKAGE`       | `cl-user`   | Default Common Lisp package for `eval`   |
| `MAX_RESULT_CHARS` | `8000`      | Truncate larger results, return a handle |
| `LOG_LEVEL`        | `INFO`      | Deno std log level                       |

## Usage

```
deno task start
```

(Permissions are the user's responsibility — run with whatever `--allow-net` / `--allow-env` flags
you prefer.)

## MCP Tools

All tools are prefixed `lisp_` to avoid name collisions with other MCP servers.

### Core eval

| Tool                | Description                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `lisp_eval`         | Evaluate a Common Lisp expression. Returns the printed value plus captured stdout. Optional `package` override. |
| `lisp_compile_file` | Compile a `.lisp` file (`compile-file-for-emacs`). Optional `load` flag (default true).                         |
| `lisp_load_file`    | `LOAD` a file in the running image.                                                                             |
| `lisp_interrupt`    | Send `:emacs-interrupt` to the REPL thread.                                                                     |

### Introspection

| Tool                   | Description                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `lisp_completions`     | Symbol completions for a prefix (flex-style). Optional `package`.                     |
| `lisp_apropos`         | Search for symbols matching a substring. Optional `externalOnly` flag (default true). |
| `lisp_describe_symbol` | Full `describe` output for a symbol.                                                  |
| `lisp_documentation`   | Docstring for a symbol.                                                               |
| `lisp_arglist`         | Argument list for a function or macro.                                                |
| `lisp_macroexpand`     | `macroexpand-1` a form (or full expansion with `all: true`).                          |
| `lisp_find_definition` | Source locations for a symbol's definitions.                                          |

### Debugger

A `lisp_eval` error suspends in the debugger; these tools inspect and resume it. (Errors from other
tools are auto-aborted, so `lisp_debug_status` reports "not in debugger" for those.)

| Tool                        | Description                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| `lisp_debug_status`         | Report the active condition, restarts, and top frames. Returns "not in debugger" if clean. |
| `lisp_debug_invoke_restart` | Invoke restart N; reports the resumed evaluation's value, or the new debugger level.       |
| `lisp_debug_abort`          | Throw to top-level, exiting all debugger levels.                                           |
| `lisp_debug_frame_locals`   | Local variables (and catch tags) for a given stack frame.                                  |
| `lisp_debug_frame_source`   | Source location for a given stack frame.                                                   |
| `lisp_debug_eval_in_frame`  | Evaluate an expression in the lexical environment of a stack frame.                        |

### Handles

Large results are automatically truncated and stored under a handle id. Use these tools to retrieve
them.

| Tool                | Description                                                                          |
| ------------------- | ------------------------------------------------------------------------------------ |
| `lisp_get_handle`   | Fetch a slice of a stored large result by handle id. Supports `offset` and `length`. |
| `lisp_list_handles` | List ids and metadata for all stored handles (up to 64, LRU).                        |

### Session

| Tool                   | Description                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `lisp_set_package`     | Set the default package for eval, completions, and all other tools (client-side, no RPC). |
| `lisp_connection_info` | Lisp implementation name/version, machine, features, current + initial package.           |

## Plugins

swankmcp ships an in-tree plugin seam for environment-specific tools that shouldn't live in the
generic Slynk bridge. Plugins are off by default and activated explicitly per run.

**Activation** — repeatable CLI flag, or comma-separated env var:

```bash
deno run -A main.ts --plugin=opusmodus
# or
SWANKMCP_PLUGINS=opusmodus deno run -A main.ts
```

An unknown plugin name aborts startup before the Slynk socket is opened.

### Inspector

Exposes the Slynk inspector. The inspector is stateful (a stack of inspected objects on the Lisp
side), so it's gated behind explicit activation.

| Tool                       | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `lisp_inspect`             | Open the Slynk inspector on an expression. Returns structured parts. |
| `lisp_inspect_part`        | Drill into part N of the current inspector view.                     |
| `lisp_inspector_pop`       | Return to the previous inspector level.                              |
| `lisp_inspector_reinspect` | Re-inspect the current object.                                       |

Activate with `--plugin=inspector`.

### Opusmodus

Adds two tools that mirror helpers from the Emacs/SLIME glue Opusmodus ships:

- `om_audition_snippet { snippet }` — wraps `(om:audition-musicxml-omn-snippet '<snippet>)`.
- `om_stop` — wraps `(progn (om:stop-midi) (om:stop-sound))`.

**Manual smoke test** (requires a running Opusmodus image with Slynk on `:4005`):

1. In Opusmodus: `(slynk:create-server :port 4005 :dont-close t)`.
2. Start swankmcp from a client that speaks MCP: `deno run -A main.ts --plugin=opusmodus`.
3. Call `om_audition_snippet` with `snippet = "((repeat (q c4 e4 g4 c4e4g4) (q a4 g4 g4 c4e4g4)))"`.
   MIDI should play and a MusicXML window should appear.
4. Call `om_stop`. Playback should halt.

## Enabling in Claude Code

### Project-wide (committed to the repo)

Register it from the command line (project scope):

```sh
claude mcp add --scope project swankmcp deno -- run --allow-net --allow-env /Users/ldbeth/Public/Projects/swankmcp/main.ts
```

This writes the entry into `.mcp.json` at the project root, which can be committed so teammates pick
it up automatically.

### User-wide (all projects)

```sh
claude mcp add --scope user swankmcp deno -- run --allow-net --allow-env --env-file /Users/ldbeth/Public/Projects/swankmcp/main.ts
```

## Enabling in Claude Desktop

Claude Desktop reads MCP servers from
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS). Generate a ready-to-paste
snippet:

```sh
deno task build
deno task export-config --plugin=opusmodus
```

The script prints a `mcpServers` snippet on stdout pointing at the bundled `main.mjs`. Whitelisted
env vars currently exported in your shell (`SLYNK_HOST`, `SLYNK_PORT`, `CL_PACKAGE`,
`MAX_RESULT_CHARS`, `LOG_LEVEL`, `SWANKMCP_PLUGINS`) are copied into the snippet's `env` block.
Splice the `mcpServers.swankmcp` entry into your existing config and restart Claude Desktop.

Flags: `--name=<id>` to change the server key, `--plugin=<name>` (repeatable) to activate plugins,
`--bundle=<abs-path>` to override the bundle path. Pass `-h` for usage.

### Prerequisites

Opusmodus must be running with Slynk loaded and listening:

```lisp
(slynk:create-server :port 4005 :dont-close t)
```

The `:dont-close t` flag is required so the listener stays open after the first connection.
