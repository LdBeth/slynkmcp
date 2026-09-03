/**
 * `slynk:compile-file-for-emacs` results: the `(:compilation-result …)` list,
 * its compiler notes, and the text swankmcp hands back.
 *
 * Slynk does not load the fasl it produces, whatever `load-p` says.
 * `slynk-compile-file*` passes `nil` for the backend's own `load-p` and merely
 * echoes the flag back in the result's LOADP field; SLY's Emacs side is what
 * loads the file afterwards. `Session.compileFile` does the same, so a caller
 * asking to load actually gets the definitions.
 *
 * Notes carry `:location`, which is the whole point here: a compile error
 * should name the file and line as directly as a runtime error does.
 */

import { formatSourceLocation } from "./debug.ts";
import { asList, isList, plistEntries, type Sexp, tagName, text } from "./sexp.ts";

export interface CompilerNote {
  /** `:error`, `:warning`, `:style-warning`, `:note`, … without the colon. */
  severity: string;
  message: string;
  /** Rendered location, e.g. `/x/y.lisp:42`. */
  location?: string;
  snippet?: string;
  /** Slynk's `:source-context`: the enclosing form, when it sent one. */
  context?: string;
}

export interface CompilationResult {
  successp: boolean;
  /** Seconds, as Slynk measured them. */
  duration: number;
  /** Whether the caller asked for the fasl to be loaded. */
  loadRequested: boolean;
  faslfile?: string;
  notes: CompilerNote[];
}

/** What became of the load step that Slynk leaves to the client. */
export type LoadOutcome =
  | { kind: "loaded"; fasl: string }
  | { kind: "failed"; fasl: string }
  | { kind: "not-requested" }
  | { kind: "nothing-to-load" };

/** Parse `(:compilation-result NOTES SUCCESSP DURATION LOADP FASLFILE)`. */
export function parseCompilationResult(raw: Sexp): CompilationResult {
  const parts = asList(raw, "compilation result");
  const truthy = (s: Sexp | undefined): boolean => !(s === undefined || isList(s));
  const faslfile = typeof parts[5] === "string" ? parts[5] : undefined;
  return {
    successp: truthy(parts[2]),
    duration: typeof parts[3] === "number" ? parts[3] : 0,
    loadRequested: truthy(parts[4]),
    ...(faslfile ? { faslfile } : {}),
    notes: (isList(parts[1]) ? parts[1] : []).map(parseNote),
  };
}

function parseNote(raw: Sexp): CompilerNote {
  const note: CompilerNote = { severity: "note", message: "" };
  for (const [key, val] of plistEntries(asList(raw, "compiler note"))) {
    switch (key) {
      case "severity":
        note.severity = tagName(val) ?? text(val);
        break;
      case "message":
        note.message = text(val).trim();
        break;
      case "source-context":
        note.context = text(val).trim();
        break;
      case "location": {
        const where = formatSourceLocation(val);
        if (where) {
          note.location = where.where;
          if (where.snippet) note.snippet = where.snippet;
        }
        break;
      }
    }
  }
  return note;
}

/**
 * One-line status, then the load result, then every note with its location.
 * Notes come first-to-last as the compiler signalled them.
 */
export function formatCompilationResult(
  path: string,
  result: CompilationResult,
  load: LoadOutcome,
): string {
  const out: string[] = [
    `${result.successp ? "Compiled" : "Compile FAILED for"} ${path}` +
    ` (${result.duration.toFixed(3)}s)`,
  ];

  switch (load.kind) {
    case "loaded":
      out.push(`Loaded ${load.fasl}`);
      break;
    case "failed":
      out.push(`Load FAILED for ${load.fasl}`);
      break;
    case "not-requested":
      out.push(`Not loaded (load was false)${result.faslfile ? `: ${result.faslfile}` : ""}`);
      break;
    case "nothing-to-load":
      out.push("Not loaded: the compile produced no fasl.");
      break;
  }

  if (result.notes.length === 0) {
    out.push("No compiler notes.");
    return out.join("\n");
  }

  out.push("", `Compiler notes (${result.notes.length}):`);
  for (const note of result.notes) {
    out.push(`  ${note.severity}${note.location ? ` at ${note.location}` : ""}`);
    if (note.message) out.push(indent(note.message, "    "));
    // `:source-context` names the enclosing form; the snippet is only the first
    // line at the location, so prefer the context when Slynk sent both.
    if (note.context) out.push(indent(`in: ${note.context}`, "    "));
    else if (note.snippet) out.push(`    in: ${note.snippet}`);
  }
  return out.join("\n");
}

function indent(s: string, prefix: string): string {
  return s.split("\n").map((line) => prefix + line).join("\n");
}
