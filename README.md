# swankmcp

MCP server bridging Claude Code to a running Lisp image (e.g. Opusmodus) via the Slynk protocol.

## Architecture

```
Claude Code  ──stdio MCP──▶  swankmcp (Deno)  ──TCP──▶  Slynk :4005  ──▶  Opusmodus / LispWorks
```

A single long-lived TCP connection to Slynk multiplexes all MCP tool calls; the connection and a
dedicated mREPL channel are opened lazily on the first tool call (see Lifecycle below). Per-request
stdout is captured via the mREPL channel. Lisp errors are auto-aborted on the Slynk side, but the
debugger is interrogated before it is unwound, so the MCP tool error carries a full report: the
condition, where the error came from (the innermost frame outside the host and Slynk that Slynk can
place in a file, with its line number), the backtrace, and anything the form printed before it broke
(see Error reports below).

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

| Var                   | Default     | Purpose                                      |
| --------------------- | ----------- | -------------------------------------------- |
| `SLYNK_HOST`          | `127.0.0.1` | Slynk listener host                          |
| `SLYNK_PORT`          | `4005`      | Slynk listener port                          |
| `CL_PACKAGE`          | `cl-user`   | Default Common Lisp package for `eval`       |
| `MAX_RESULT_CHARS`    | `8000`      | Truncate larger results, return a handle     |
| `SLYNK_DEBUG_FRAMES`  | `32`        | Backtrace frames included in an error report |
| `SLYNK_DEBUG_SOURCES` | `8`         | Innermost frames asked for a source location |
| `LOG_LEVEL`           | `INFO`      | Deno std log level                           |

Set `SLYNK_DEBUG_SOURCES=0` to skip source probing entirely (it costs one Slynk round trip per
frame). Frames belonging to Slynk or to the host's own packages don't count against that budget and
are never probed, since every eval runs through `slynk:interactive-eval` and probing those would
only ever place the error inside the bridge. Which frames those are is decided by the home package
of the function each frame names, looked up in the Lisp image in one extra round trip before the
probes start: the printed frame text can't be trusted for it, because a symbol accessible in your
current package prints with no package prefix at all, so `common-lisp:error` shows up as a bare
`error` just like one of your own functions. `SLYNK_DEBUG_FRAMES` above 20 costs one extra
`slynk:backtrace` call, since Slynk volunteers only `*sly-db-initial-frames*` frames in the
`(:debug …)` event; the default is above that because 20 frames cut real frames off deep stacks in
testing.

## Error reports

swankmcp has no interactive debugger: every debugger entry is unwound automatically, so a tool call
never wedges waiting for a restart choice. The frames only exist until that unwind, so on
`(:debug-activate …)` the session asks Slynk where the innermost frames live, then invokes the
restart. The report's job is to say where the error came from, so it leads with that location. The
tool result is an `isError` result holding:

```
Lisp error — [Condition of type DIVISION-BY-ZERO]
  Division-by-zero caused by / of (7 0).

Error source: /Users/x/score.lisp:42
  frame 2 (MANGLE (1 2 3))
  (defun mangle (xs)

Output before the error:
  computing…

Backtrace (innermost 4 frames):
  0 (SYSTEM::DIVISION-BY-ZERO-ERROR 7 0)
  1 (SYSTEM::ANONYMOUS-LAMBDA "<functor>" "<args>")
  2 (MANGLE (1 2 3))
      at /Users/x/score.lisp:42
  3 (OM::GEN-REPEAT 3 NIL)
  … deeper frames omitted; raise SLYNK_DEBUG_FRAMES to see them.
```

`Error source` names the innermost frame Slynk could place in a file, with the line number and the
source snippet when Slynk sends one — and it never names a frame belonging to Slynk or to the host:
those are left unprobed, so the headline can't point at the bridge instead of the error.

Plenty of code cannot be placed at all. A form typed at `lisp_eval` has no file behind it, and a
library shipped without recorded source never places — Opusmodus is one, where even
`lisp_find_definition` on `gen-repeat` answers `Cannot resolve location: :unknown`. So a report with
no location is a normal outcome, not a malfunction, and it still answers "where" as far as it can by
naming the innermost frame that is neither the host's nor Slynk's:

```
Error source: not recorded.
  Innermost application frame: 2 (MANGLE (1 2 3))
  None of the 2 probed frames has a source location.
  A form typed at lisp_eval has no file behind it, and library code shipped
  without source never places. Compile your own code from a file with
  lisp_compile_file and its frames place the failing call — though a caller
  that ends in the failing call may be gone anyway, since LispWorks drops
  tail calls.
```

That line says "application frame" rather than "your own code" on purpose: on an image like
Opusmodus your definitions and the library's live in the same package — anything you evaluate or
compile through the bridge is read in the default package — so the frame named there is often the
library's, and only a source location can tell the two apart. When the whole stack is the host's and
Slynk's — an anonymous form typed at `lisp_eval` — there is no application frame to name either, and
the section says `No application frame on this stack: it is all host and Slynk internals.` instead.
With `SLYNK_DEBUG_SOURCES=0` it reports that it never looked.

What compiling from a file buys is the **call boundary**: the named function that broke, with the
arguments it was called on, placed at a line. An inner lambda or a loop variable is not recovered —
the compiler has usually inlined it away. Nor can it recover a frame the compiler never made:
LispWorks eliminates tail calls, so a function whose body _ends_ in the call that failed leaves no
frame on the stack at all. In one test two functions compiled from a file, both with perfectly good
source locations, were simply absent from the backtrace for that reason, while an earlier one
survived only because its call was not in tail position. So compiling from a file is still the thing
that makes an error placeable, but a caller you expected to see may not be there. A backtrace that
fills `SLYNK_DEBUG_FRAMES` is labelled as cut short rather than passed off as the whole stack.

`lisp_compile_file` compiles and then loads the fasl (Slynk itself never loads it), and reports each
compiler note with its severity, location, and enclosing form:

```
Compiled /tmp/broken.lisp (0.008s)
Loaded /tmp/broken.64yfasl

Compiler notes (2):
  warning at /tmp/broken.lisp @19
    Undefined variable X
    in: (defun scaled-gaps (xs k) ...)
  error
    The function FOO is undefined.
```

A failed compile says `Compile FAILED for <path>` and `Not loaded: the compile produced no fasl.`; a
failed load is an error result carrying the same compilation summary followed by the load error's
own report.

Reports longer than `MAX_RESULT_CHARS` are truncated into a handle like any other oversized result,
so the rest of a deep backtrace is one `lisp_get_handle` call away.

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
| `lisp_compile_file` | Compile a `.lisp` file and load the fasl (`load` flag, default true). Reports compiler notes with location.     |
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
`MAX_RESULT_CHARS`, `SLYNK_DEBUG_FRAMES`, `SLYNK_DEBUG_SOURCES`, `LOG_LEVEL`, `SWANKMCP_PLUGINS`)
are copied into the snippet's `env` block. Splice the `mcpServers.swankmcp` entry into your existing
config and restart Claude Desktop.

Flags: `--name=<id>` to change the server key, `--plugin=<name>` (repeatable) to activate plugins,
`--bundle=<abs-path>` to override the bundle path. Pass `-h` for usage.

### Prerequisites

Opusmodus must be running with Slynk loaded and listening:

```lisp
(slynk:create-server :port 4005 :dont-close t)
```

The `:dont-close t` flag is required so the listener stays open after the first connection.
