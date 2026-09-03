import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { asList, read } from "./sexp.ts";
import {
  describeError,
  formatSourceLocation,
  frameHead,
  type FrameInfo,
  frameOrigin,
  headPackage,
  isInfrastructurePackage,
  parseBacktrace,
  parseDebugEvent,
  SlynkDebugError,
} from "./debug.ts";

/**
 * The frame that made this necessary: every eval goes through
 * `slynk:interactive-eval`, whose source file is right there on disk, so it was
 * routinely the innermost frame that could be placed — and the report pointed
 * at the bridge instead of at the caller.
 */
const SLYNK_FRAME = "((harlequin-common-lisp:subfunction 1 " +
  "(harlequin-common-lisp:subfunction 1 slynk:interactive-eval)))";

const DEBUG_EVENT = `(:debug 6 1
 ("Arithmetic error DIVISION-BY-ZERO signalled.
Operation was (/ 1 0)."
  "   [Condition of type DIVISION-BY-ZERO]"
  nil)
 (("*ABORT" "Return to SLY's top level.") ("ABORT" "abort thread"))
 ((0 "(SB-KERNEL::INTEGER-/-INTEGER 1 0)" (:restartable nil))
  (1 "(FOO 1)" (:restartable t)))
 (7))`;

function debugInfo(src = DEBUG_EVENT) {
  return parseDebugEvent(asList(read(src), "event"));
}

// ---- parseDebugEvent ----

Deno.test("parseDebugEvent - condition, thread, and level", () => {
  const info = debugInfo();
  assertEquals(info.thread, 6);
  assertEquals(info.level, 1);
  assertEquals(info.condition.type, "[Condition of type DIVISION-BY-ZERO]");
  assertStringIncludes(info.condition.message, "Operation was (/ 1 0).");
});

Deno.test("parseDebugEvent - strips the `*` quit marker from restart names", () => {
  const { restarts } = debugInfo();
  assertEquals(restarts[0], {
    index: 0,
    name: "ABORT",
    quit: true,
    description: "Return to SLY's top level.",
  });
  assertEquals(restarts[1]!.quit, false);
});

Deno.test("parseDebugEvent - frames keep their Slynk index", () => {
  const { frames } = debugInfo();
  assertEquals(frames.length, 2);
  assertEquals(frames[0]!.index, 0);
  assertEquals(frames[0]!.description, "(SB-KERNEL::INTEGER-/-INTEGER 1 0)");
});

Deno.test("parseDebugEvent - keeps the parked rex ids", () => {
  assertEquals(debugInfo().pendingIds, [7]);
});

Deno.test("parseDebugEvent - tolerates an empty pending-continuations list", () => {
  const src = `(:debug 6 1 ("boom" "[Condition of type SIMPLE-ERROR]" nil) (("ABORT" "x")) () nil)`;
  assertEquals(debugInfo(src).pendingIds, []);
});

// ---- backtrace / source ----

Deno.test("parseBacktrace - reads (index description plist) triples", () => {
  const frames = parseBacktrace(read(`((0 "(BAR)" (:restartable t)) (1 "(BAZ)"))`));
  assertEquals(frames.map((f) => f.description), ["(BAR)", "(BAZ)"]);
});

Deno.test("formatSourceLocation - file with a line number", () => {
  const raw = read(`(:location (:file "/tmp/foo.lisp") (:line 42) nil)`);
  assertEquals(formatSourceLocation(raw), { where: "/tmp/foo.lisp:42" });
});

Deno.test("formatSourceLocation - file with a character position", () => {
  const raw = read(`(:location (:file "/tmp/foo.lisp") (:position 128) nil)`);
  assertEquals(formatSourceLocation(raw), { where: "/tmp/foo.lisp @128" });
});

Deno.test("formatSourceLocation - snippet comes back beside the location", () => {
  const raw = read(
    `(:location (:file "/tmp/foo.lisp") (:line 42) (:snippet "(defun foo ()\nnext line"))`,
  );
  assertEquals(formatSourceLocation(raw), {
    where: "/tmp/foo.lisp:42",
    snippet: "(defun foo ()",
  });
});

Deno.test("formatSourceLocation - undefined when Slynk has no location", () => {
  assertEquals(formatSourceLocation(read(`(:error "No source for frame")`)), undefined);
});

// ---- frame origin ----

function frame(description: string, pkg?: string): FrameInfo {
  return { index: 0, description, ...(pkg ? { package: pkg } : {}) };
}

Deno.test("frameHead - the function a frame names, as printed", () => {
  assertEquals(frameHead(`(gen-repeat* "three" (c4 e4 g4))`), "gen-repeat*");
  assertEquals(frameHead("(SB-KERNEL::INTEGER-/-INTEGER 1 0)"), "SB-KERNEL::INTEGER-/-INTEGER");
  // LispWorks nests the closure that carries Slynk's transport frame.
  assertEquals(frameHead(SLYNK_FRAME), "harlequin-common-lisp:subfunction");
  assertEquals(frameHead("   "), undefined);
});

Deno.test("headPackage - only a printed prefix counts as a package", () => {
  assertEquals(headPackage(SLYNK_FRAME), "harlequin-common-lisp");
  assertEquals(headPackage("(SYSTEM::DIVISION-BY-ZERO-ERROR 7 0)"), "SYSTEM");
  // Bare heads carry no prefix — `om` inherits `common-lisp`, so even
  // `common-lisp:error` prints like this.
  assertEquals(headPackage("(error #<undefined-function>)"), undefined);
  assertEquals(headPackage(`(gen-repeat* "three")`), undefined);
});

Deno.test("isInfrastructurePackage - the host's own packages and Slynk's", () => {
  assertEquals(isInfrastructurePackage("COMMON-LISP"), true);
  assertEquals(isInfrastructurePackage("SYSTEM"), true);
  assertEquals(isInfrastructurePackage("CONDITIONS"), true);
  assertEquals(isInfrastructurePackage("HARLEQUIN-COMMON-LISP"), true);
  // Whole families, not just the bare names.
  assertEquals(isInfrastructurePackage("SLYNK-MREPL"), true);
  assertEquals(isInfrastructurePackage("SB-KERNEL"), true);
});

Deno.test("isInfrastructurePackage - the application's own package is not", () => {
  // On this image the caller's definitions and Opusmodus's both live in
  // OPUSMODUS, so no package test can separate them — probing does, and it
  // only gets the chance if the package test lets the frame through.
  assertEquals(isInfrastructurePackage("OPUSMODUS"), false);
  assertEquals(isInfrastructurePackage("COMMON-LISP-USER"), false);
});

Deno.test("frameOrigin - a resolved infrastructure package is library", () => {
  // The frame that motivated the change: `error` prints bare, exactly like a
  // user's own function, and the old printed-text rule named it as the fault.
  assertEquals(frameOrigin(frame("(error #<undefined-function>)", "COMMON-LISP")), "library");
  assertEquals(frameOrigin(frame(SLYNK_FRAME, "SLYNK")), "library");
});

Deno.test("frameOrigin - a resolved application package is application", () => {
  assertEquals(frameOrigin(frame("(MANGLE (1 2 3))", "OPUSMODUS")), "application");
  // The resolved package outranks the printed prefix.
  assertEquals(frameOrigin(frame("(OM::MAKE-LINE 4)", "OPUSMODUS")), "application");
});

Deno.test("frameOrigin - without a package the prefix can only prove library", () => {
  assertEquals(frameOrigin(frame(SLYNK_FRAME)), "library");
  assertEquals(frameOrigin(frame("(SB-KERNEL::INTEGER-/-INTEGER 1 0)")), "library");
  // A non-infrastructure prefix still proves nothing: OM inherits CL too.
  assertEquals(frameOrigin(frame("(OM::MAKE-LINE 4)")), "unknown");
});

Deno.test("frameOrigin - a bare head is unknown until its package resolves", () => {
  assertEquals(frameOrigin(frame("(error #<undefined-function>)")), "unknown");
  assertEquals(frameOrigin(frame("(MANGLE (1 2 3))")), "unknown");
});

// ---- report ----

Deno.test("SlynkDebugError - message stays a single line", () => {
  const e = new SlynkDebugError(debugInfo(), "#<DIVISION-BY-ZERO>");
  assertEquals(e.message.includes("\n"), false);
  assertStringIncludes(e.message, "DIVISION-BY-ZERO");
});

Deno.test("formatDebugReport - leads with the source of the innermost located frame", () => {
  const info = debugInfo();
  info.sourceProbeDepth = 2;
  // Frame 0 is host arithmetic machinery with no file behind it; frame 1 is
  // the user's code, and that is the line the report must headline.
  info.frames[1]!.source = "/tmp/foo.lisp:42";
  info.frames[1]!.snippet = "(defun foo (n)";
  const e = new SlynkDebugError(info, "#<DIVISION-BY-ZERO>");
  e.output = "half a line\n";

  const report = e.report();
  assertStringIncludes(report, "[Condition of type DIVISION-BY-ZERO]");
  assertStringIncludes(report, "Operation was (/ 1 0).");
  assertStringIncludes(
    report,
    "Error source: /tmp/foo.lisp:42\n  frame 1 (FOO 1)\n  (defun foo (n)",
  );
  assertStringIncludes(report, "Output before the error:\n  half a line");
  assertStringIncludes(report, "0 (SB-KERNEL::INTEGER-/-INTEGER 1 0)");
  assertStringIncludes(report, "1 (FOO 1)\n      at /tmp/foo.lisp:42");
});

Deno.test("formatDebugReport - never lists restarts", () => {
  const report = new SlynkDebugError(debugInfo(), "#<DIVISION-BY-ZERO>").report();
  assertEquals(report.includes("Restarts"), false);
  assertEquals(report.includes("abort thread"), false);
  assertEquals(report.includes("Return to SLY's top level."), false);
  assertEquals(report.includes("auto-aborted"), false);
  assertEquals(report.includes("Abort reason"), false);
});

/** The advice tail every "not recorded" report ends with. */
const ADVICE = "  A form typed at lisp_eval has no file behind it, and library code shipped\n" +
  "  without source never places. Compile your own code from a file with\n" +
  "  lisp_compile_file and its frames place the failing call — though a caller\n" +
  "  that ends in the failing call may be gone anyway, since LispWorks drops\n" +
  "  tail calls.";

Deno.test("formatDebugReport - falls back to the innermost application frame", () => {
  // Nothing placed — the normal outcome on an image whose libraries ship
  // without recorded source. The report still has to answer "where", so it
  // names the innermost frame whose home package is the application's.
  const info = debugInfo();
  info.sourceProbeDepth = 2;
  info.packagesResolved = true;
  info.frames[1]!.package = "COMMON-LISP-USER";
  const report = new SlynkDebugError(info, "nil").report();
  assertStringIncludes(
    report,
    "Error source: not recorded.\n" +
      "  Innermost application frame: 1 (FOO 1)\n" +
      "  None of the 2 probed frames has a source location.\n" +
      ADVICE,
  );
});

Deno.test("formatDebugReport - names nothing when no frame's package resolved", () => {
  // Frame 1 prints bare, so it could equally be `common-lisp:error`. With no
  // resolved package it stays unknown: probed, but never named.
  const info = debugInfo();
  info.sourceProbeDepth = 2;
  const report = new SlynkDebugError(info, "nil").report();
  assertStringIncludes(
    report,
    "Error source: not recorded.\n" +
      "  None of the 2 probed frames has a source location.\n" +
      ADVICE,
  );
  assertEquals(report.includes("Innermost application frame"), false);
});

Deno.test("formatDebugReport - says so when the resolved stack is all infrastructure", () => {
  // Packages resolved, nothing came back as the application's, so nothing was
  // probed and there is nothing to name. The remedy is still the caller's: a
  // form typed at lisp_eval leaves only host frames behind.
  const allInfrastructure = `(:debug 6 1 ("boom" "[Condition of type SIMPLE-ERROR]" nil)
    (("ABORT" "x")) ((0 "(SYSTEM::DIVISION-BY-ZERO-ERROR 7 0)") (1 "${SLYNK_FRAME}")) (7))`;
  const info = debugInfo(allInfrastructure);
  info.sourceProbeDepth = 0;
  info.packagesResolved = true;
  const report = new SlynkDebugError(info, "nil").report();
  assertStringIncludes(
    report,
    "Error source: not recorded.\n" +
      "  No application frame on this stack: it is all host and Slynk internals.\n" +
      ADVICE,
  );
  assertEquals(report.includes("Innermost application frame"), false);
});

Deno.test("formatDebugReport - labels a backtrace that was cut short", () => {
  const info = debugInfo();
  info.framesTruncated = true;
  const truncated = new SlynkDebugError(info, "nil").report();
  assertStringIncludes(truncated, "Backtrace (innermost 2 frames):");
  assertStringIncludes(truncated, "… deeper frames omitted; raise SLYNK_DEBUG_FRAMES to see them.");

  const whole = new SlynkDebugError(debugInfo(), "nil").report();
  assertStringIncludes(whole, "Backtrace (all 2 frames):");
  assertEquals(whole.includes("deeper frames omitted"), false);
});

Deno.test("formatDebugReport - abort reason stands in for an empty condition message", () => {
  const src = `(:debug 6 1 ("" "[Condition of type SIMPLE-ERROR]" nil) nil nil nil)`;
  const report = new SlynkDebugError(debugInfo(src), "#<SIMPLE-ERROR {1005}>").report();
  assertStringIncludes(report, "  #<SIMPLE-ERROR {1005}>");
});

Deno.test("formatDebugReport - omits sections it has nothing for", () => {
  const src = `(:debug 6 1 ("boom" "[Condition of type SIMPLE-ERROR]" nil) nil nil nil)`;
  const report = new SlynkDebugError(debugInfo(src), "nil").report();
  assertStringIncludes(report, "boom");
  assertEquals(report.includes("Backtrace"), false);
  assertEquals(report.includes("Output before the error"), false);
  assertStringIncludes(report, "Error source: not looked up");
});

// ---- describeError ----

Deno.test("describeError - full report for debugger errors", () => {
  const e = new SlynkDebugError(debugInfo(), "nil");
  assert(describeError(e).includes("Backtrace"));
});

Deno.test("describeError - plain message for anything else", () => {
  assertEquals(describeError(new Error("Not connected")), "Not connected");
  assertEquals(describeError("bare string"), "bare string");
});
