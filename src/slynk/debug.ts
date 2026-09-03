/**
 * Debugger model: parse Slynk's `(:debug …)` event into a structured
 * `DebugInfo`, carry that back to the caller on `(:return (:abort …) ID)` as a
 * `SlynkDebugError`, and render it as the report the MCP layer hands the model.
 *
 * swankmcp has no interactive debugger — every debugger entry is auto-aborted
 * (`session.ts` `onDebugActivate`). The report is therefore the model's only
 * look at the failure, and its job is to answer *where the error came from*:
 * `Session` asks Slynk for the source location of the innermost frames while
 * the debugger is still on the stack, then aborts, and this module leads the
 * report with the first frame that resolved to a file.
 *
 * Restarts are parsed but never printed. Nothing downstream can invoke one, so
 * listing them only pads the report; `Session` uses them to pick how to unwind.
 *
 * Field layout of `(:debug THREAD LEVEL CONDITION RESTARTS FRAMES PENDING-IDS)`
 * comes from `slynk:debugger-info-for-emacs`:
 *   CONDITION   ::= (message type extras)
 *   RESTARTS    ::= ((name description)*)   — the quit restart's name is
 *                                             prefixed with `*`
 *   FRAMES      ::= ((index description [plist])*)
 *   PENDING-IDS ::= (rex-id*)               — `*pending-continuations*`
 */

import { asList, isKw, isList, plistEntries, print, type Sexp, tagName, text } from "./sexp.ts";

export interface ConditionInfo {
  /** Printed condition, as `princ` would show it. Often multi-line. */
  message: string;
  /** Slynk's `"[Condition of type FOO]"` line, whitespace-trimmed. */
  type: string;
  /** `condition-extras` plist: `(:references …)` and friends; `[]` when none. */
  extras: Sexp;
}

export interface RestartInfo {
  index: number;
  /** Restart name with Slynk's `*` quit marker stripped. */
  name: string;
  description: string;
  /** True when Slynk marked this as `*sly-db-quit-restart*` (leading `*`). */
  quit: boolean;
}

export interface FrameInfo {
  index: number;
  description: string;
  /** Home package of the function this frame names, resolved on the Lisp side. */
  package?: string;
  /**
   * Rendered `slynk:frame-source-location`, e.g. `/x/y.lisp:42`. Set only for
   * the frames `Session` probed, and only when Slynk had a location for them.
   */
  source?: string;
  /** First line of the source snippet Slynk sent with the location, if any. */
  snippet?: string;
}

export interface DebugInfo {
  thread: number;
  level: number;
  condition: ConditionInfo;
  restarts: RestartInfo[];
  frames: FrameInfo[];
  /** rex ids parked in this debugger level. Empty for non-rex errors. */
  pendingIds: number[];
  /** True when the stack likely continues below the last reported frame. */
  framesTruncated?: boolean;
  /** How many frames were asked for a source location. */
  sourceProbeDepth?: number;
  /** True once frame home packages were looked up (or found unnecessary). */
  packagesResolved?: boolean;
}

/** Strip Slynk's `*` quit-restart marker from a restart name. */
function restartName(raw: string): { name: string; quit: boolean } {
  return raw.startsWith("*") ? { name: raw.slice(1), quit: true } : { name: raw, quit: false };
}

// The optional trailing plist (currently only `(:restartable …)`) is dropped:
// nothing can act on it until an interactive debugger exists.
function parseFrame(raw: Sexp): FrameInfo {
  const fl = asList(raw, "frame");
  return {
    index: typeof fl[0] === "number" ? fl[0] : 0,
    description: text(fl[1]),
  };
}

/** Parse `(:debug THREAD LEVEL CONDITION RESTARTS FRAMES PENDING-IDS)`. */
export function parseDebugEvent(event: Sexp[]): DebugInfo {
  const condList = asList(event[3] ?? [], ":debug condition");
  const restartList = asList(event[4] ?? [], ":debug restarts");
  const frameList = asList(event[5] ?? [], ":debug frames");
  const pendingList = isList(event[6]) ? event[6] : [];

  return {
    thread: typeof event[1] === "number" ? event[1] : 0,
    level: typeof event[2] === "number" ? event[2] : 0,
    condition: {
      message: text(condList[0]).trim(),
      type: text(condList[1]).trim(),
      extras: condList[2] ?? [],
    },
    restarts: restartList.map((r, index) => {
      const rl = asList(r, "restart");
      const { name, quit } = restartName(text(rl[0]));
      return { index, name, quit, description: text(rl[1]) };
    }),
    frames: frameList.map(parseFrame),
    pendingIds: pendingList.filter((x): x is number => typeof x === "number"),
  };
}

/** Parse the `((I DESC [PLIST])*)` result of `slynk:backtrace`. */
export function parseBacktrace(raw: Sexp): FrameInfo[] {
  return asList(raw, "backtrace").map(parseFrame);
}

/** Slynk's placeholder when a frame's own printer errored. */
export const UNPRINTABLE_FRAME = "[error printing frame]";

/**
 * Packages whose frames are plumbing rather than an answer to "where did this
 * break?" — the host's own error machinery and Slynk's transport. Every rex
 * runs through `slynk:interactive-eval`, so without this the innermost frame
 * carrying *any* location is routinely Slynk's own source file, which reads as
 * though the fault were inside the bridge.
 *
 * Judged by *home package*, not by the printed prefix. A Lisp prints a symbol
 * without its package whenever the symbol is accessible in `*package*`, so with
 * a default package of `om` (which inherits `common-lisp`) `common-lisp:error`
 * prints as bare `error` — the printed text alone cannot tell it from a user's
 * own function. `Session` resolves bare heads through `find-symbol` on the Lisp
 * side; the prefix is only a fallback for when that lookup is unavailable.
 *
 * Deliberately absent: the application's own libraries. On this image the
 * caller's definitions and Opusmodus's both live in `OPUSMODUS`, so no package
 * test can separate them — what separates them is whether Slynk has a source
 * location, which is what probing finds out.
 */
const INFRASTRUCTURE_PACKAGES = new Set([
  "common-lisp",
  "keyword",
  "conditions",
  "system",
  "sys",
  "si",
  "clos",
  "pcl",
  "loop",
  "compiler",
  "walker",
  "structure",
  // LispWorks internals
  "harlequin-common-lisp",
  "hcl",
  "lispworks",
  "lw",
  "mp",
  "dbg",
  // CCL / Allegro internals
  "ccl",
  "ccl-internals",
  "excl",
]);

/** Whole families: every `slynk…` contrib, every SBCL `sb-…` internal. */
const INFRASTRUCTURE_PREFIXES = ["slynk", "sb-"];

/** True for a package name that belongs to the host or to Slynk. */
export function isInfrastructurePackage(name: string): boolean {
  const lower = name.toLowerCase();
  return INFRASTRUCTURE_PACKAGES.has(lower) ||
    INFRASTRUCTURE_PREFIXES.some((p) => lower.startsWith(p));
}

/**
 * The function a frame names, as printed: `(gen-repeat* "three" …)` →
 * `gen-repeat*`. Undefined when the frame doesn't start with something
 * symbol-shaped.
 */
export function frameHead(description: string): string | undefined {
  return /^[\s(]*([^\s()"]+)/.exec(description)?.[1];
}

/** The package prefix of a printed head, e.g. `system::foo` → `system`. */
export function headPackage(description: string): string | undefined {
  const head = frameHead(description);
  const colon = head?.indexOf(":") ?? -1;
  return head && colon > 0 ? head.slice(0, colon) : undefined;
}

/**
 * Where a frame's code comes from.
 *
 * `library` is the host or Slynk: never worth a probe, never worth naming.
 * `application` is everything else, but only once the home package is known —
 * a bare printed head is `unknown` until then, because it could equally be
 * `common-lisp:error`. Unknown frames are still probed (they might place) and
 * are never named, so a failed lookup degrades to silence rather than to the
 * confident wrong answer.
 */
export function frameOrigin(frame: FrameInfo): "library" | "application" | "unknown" {
  if (frame.package) return isInfrastructurePackage(frame.package) ? "library" : "application";
  const prefix = headPackage(frame.description);
  if (prefix && isInfrastructurePackage(prefix)) return "library";
  return "unknown";
}

/**
 * Render `slynk:frame-source-location` as `file:line` / `file @offset`, plus
 * the snippet Slynk sometimes sends alongside. Returns undefined for
 * `(:error …)` — a frame with no recorded source is not worth a report line.
 */
export function formatSourceLocation(
  raw: Sexp,
): { where: string; snippet?: string } | undefined {
  if (!isList(raw) || !isKw(raw[0], "location")) return undefined;

  let where = "";
  const buffer = raw[1];
  if (isList(buffer)) {
    const kind = tagName(buffer[0]);
    if (kind === "file" || kind === "zip") where = text(buffer[1]);
    else if (kind === "buffer" || kind === "buffer-and-file") where = text(buffer[1]);
    else if (kind === "source-form") where = "(source form)";
  }

  let at = "";
  const position = raw[2];
  if (isList(position)) {
    const kind = tagName(position[0]);
    const n = position[1];
    const m = position[2];
    if (kind === "line" && typeof n === "number") at = `:${n}`;
    else if (kind === "position" && typeof n === "number") at = ` @${n}`;
    // `(:offset START OFFSET)` is a character position expressed relative to a
    // start; the absolute one is their sum.
    else if (kind === "offset" && typeof n === "number") {
      at = ` @${typeof m === "number" ? n + m : n}`;
    }
  }
  if (!where && !at) return undefined;

  let snippet = "";
  if (isList(raw[3])) {
    for (const [key, val] of plistEntries(raw[3])) {
      if (key === "snippet") snippet = text(val).trim();
    }
  }
  return { where: where + at, ...(snippet ? { snippet: snippet.split("\n")[0] } : {}) };
}

/**
 * Rejection carrying a full debugger snapshot. `message` stays a one-liner so
 * logs and nested error strings stay readable; `report()` is the multi-line
 * text the MCP layer surfaces to the model.
 */
export class SlynkDebugError extends Error {
  /** Output the failing call printed before it entered the debugger. */
  output?: string;

  constructor(
    readonly info: DebugInfo,
    /** `prin1` of the condition, from `(:return (:abort REASON) ID)`. */
    readonly abortReason: string,
  ) {
    super(`${info.condition.type || "Lisp error"} ${firstLine(info.condition.message)}`.trim());
    this.name = "SlynkDebugError";
  }

  report(): string {
    return formatDebugReport(this);
  }
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return i < 0 ? s : s.slice(0, i) + " …";
}

function indent(s: string, prefix: string): string {
  return s.split("\n").map((line) => prefix + line).join("\n");
}

/**
 * Multi-line report. Ordered by what a caller needs first: what broke, where it
 * broke, what it had printed by then, and only then the stack it broke on.
 */
export function formatDebugReport(e: SlynkDebugError): string {
  const { info } = e;
  const out: string[] = [];

  out.push(`Lisp error — ${info.condition.type || "condition"}`);
  if (info.condition.message) out.push(indent(info.condition.message, "  "));
  // Degenerate case: a condition that printed as nothing. The wire's abort
  // reason (`prin1` of the condition) is then the only text there is.
  else if (e.abortReason && e.abortReason !== "nil") out.push(indent(e.abortReason, "  "));
  if (isList(info.condition.extras) && info.condition.extras.length > 0) {
    out.push(`  extras: ${print(info.condition.extras)}`);
  }
  if (info.level > 1) out.push(`  (nested debugger level ${info.level})`);

  out.push("", ...sourceSection(info));

  if (e.output) {
    out.push("", "Output before the error:", indent(e.output.replace(/\n+$/, ""), "  "));
  }

  if (info.frames.length > 0) {
    const header = info.framesTruncated ? "innermost" : "all";
    out.push("", `Backtrace (${header} ${info.frames.length} frames):`);
    for (const f of info.frames) {
      out.push(`  ${f.index} ${f.description}`);
      if (f.source) out.push(`      at ${f.source}`);
    }
    if (info.framesTruncated) {
      out.push("  … deeper frames omitted; raise SLYNK_DEBUG_FRAMES to see them.");
    }
  }
  return out.join("\n");
}

/**
 * The headline: the innermost frame Slynk could place in a file. When nothing
 * places, say why rather than leaving a hole — a form handed to `lisp_eval` has
 * no file behind it, so the fix is to load the definition from one.
 */
function sourceSection(info: DebugInfo): string[] {
  const located = info.frames.find((f) => f.source);
  if (located) {
    return [
      `Error source: ${located.source}`,
      `  frame ${located.index} ${located.description}`,
      ...(located.snippet ? [`  ${located.snippet}`] : []),
    ];
  }
  const depth = info.sourceProbeDepth;
  if (depth === undefined) return ["Error source: not looked up (SLYNK_DEBUG_SOURCES is 0)."];

  // Nothing placed — the common case on an image whose libraries ship without
  // recorded source (Opusmodus resolves even `gen-repeat` to :unknown). Say so
  // as a plain fact, then give the best answer still available: the innermost
  // frame that is not the host's or Slynk's.
  const out = ["Error source: not recorded."];
  const application = info.frames.find((f) =>
    f.description !== UNPRINTABLE_FRAME && frameOrigin(f) === "application"
  );

  if (application) {
    out.push(
      `  Innermost application frame: ${application.index} ${application.description}`,
      `  None of the ${depth} probed frames has a source location.`,
    );
  } else if (info.packagesResolved && depth === 0) {
    out.push("  No application frame on this stack: it is all host and Slynk internals.");
  } else {
    out.push(`  None of the ${depth} probed frames has a source location.`);
  }

  out.push(
    "  A form typed at lisp_eval has no file behind it, and library code shipped",
    "  without source never places. Compile your own code from a file with",
    "  lisp_compile_file and its frames place the failing call — though a caller",
    "  that ends in the failing call may be gone anyway, since LispWorks drops",
    "  tail calls.",
  );
  return out;
}

/** Error text for a tool result: the full report for debugger errors. */
export function describeError(e: unknown): string {
  if (e instanceof SlynkDebugError) return e.report();
  return e instanceof Error ? e.message : String(e);
}
