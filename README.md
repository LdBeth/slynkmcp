# swankmcp

MCP server bridging Claude Code to a running Lisp image (e.g. Opusmodus) via the Slynk protocol.

## Architecture

```
Claude Code  ──stdio MCP──▶  swankmcp (Deno)  ──TCP──▶  Slynk :4005  ──▶  Opusmodus / LispWorks
```

A single long-lived TCP connection to Slynk multiplexes all MCP tool calls. A dedicated mREPL
channel is created at startup so per-request stdout is captured cleanly. Errors that drop into the
Slynk debugger are surfaced as MCP tool errors carrying the condition + restart list, and a set of
`debug_*` tools let the model query frames, eval in frames, and invoke restarts (or abort).

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

### Core eval

| Tool           | Description                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `eval`         | Evaluate a Common Lisp expression. Returns the printed value plus captured stdout. Optional `package` override. |
| `compile_file` | Compile a `.lisp` file (`compile-file-for-emacs`). Optional `load` flag (default true).                         |
| `load_file`    | `LOAD` a file in the running image.                                                                             |
| `interrupt`    | Send `:emacs-interrupt` to the REPL thread.                                                                     |

### Introspection

| Tool              | Description                                                                           |
| ----------------- | ------------------------------------------------------------------------------------- |
| `completions`     | Symbol completions for a prefix (flex-style). Optional `package`.                     |
| `apropos`         | Search for symbols matching a substring. Optional `externalOnly` flag (default true). |
| `describe_symbol` | Full `describe` output for a symbol.                                                  |
| `documentation`   | Docstring for a symbol.                                                               |
| `arglist`         | Argument list for a function or macro.                                                |
| `macroexpand`     | `macroexpand-1` a form (or full expansion with `all: true`).                          |
| `find_definition` | Source locations for a symbol's definitions.                                          |

### Inspector

| Tool                  | Description                                                          |
| --------------------- | -------------------------------------------------------------------- |
| `inspect`             | Open the Slynk inspector on an expression. Returns structured parts. |
| `inspect_part`        | Drill into part N of the current inspector view.                     |
| `inspector_pop`       | Return to the previous inspector level.                              |
| `inspector_reinspect` | Re-inspect the current object.                                       |

### Debugger

| Tool                   | Description                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `debug_status`         | Report the active condition, restarts, and top frames. Returns "not in debugger" if clean. |
| `debug_invoke_restart` | Invoke restart N from the list shown by `debug_status`.                                    |
| `debug_abort`          | Throw to top-level, exiting all debugger levels.                                           |
| `debug_frame_locals`   | Local variables (and catch tags) for a given stack frame.                                  |
| `debug_frame_source`   | Source location for a given stack frame.                                                   |
| `debug_eval_in_frame`  | Evaluate an expression in the lexical environment of a stack frame.                        |

### Handles

Large results are automatically truncated and stored under a handle id. Use these tools to retrieve
them.

| Tool           | Description                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `get_handle`   | Fetch a slice of a stored large result by handle id. Supports `offset` and `length`. |
| `list_handles` | List ids and metadata for all stored handles (up to 64, LRU).                        |

### Session

| Tool              | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `connection_info` | Lisp implementation name/version, machine, features, current package. |

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

### Prerequisites

Opusmodus must be running with Slynk loaded and listening:

```lisp
(slynk:create-server :port 4005 :dont-close t)
```

The `:dont-close t` flag is required so the listener stays open after the first connection.
