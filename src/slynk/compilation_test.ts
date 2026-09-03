/**
 * `slynk:compile-file-for-emacs` results: reading the `(:compilation-result …)`
 * list, and rendering it together with the load step Slynk leaves to us —
 * `slynk-compile-file*` only echoes `load-p` back, it never loads the fasl.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { read } from "./sexp.ts";
import { formatCompilationResult, parseCompilationResult } from "./compilation.ts";

/** A successful compile that still had things to say about the file. */
const COMPILE_OK = `(:compilation-result
 ((:message "Undefined function GEN-REPEAT"
   :severity :style-warning
   :location (:location (:file "/tmp/scratch.lisp") (:line 12)
              (:snippet "(defun make-line (n)
  (gen-repeat n 1))"))
   :source-context "(DEFUN MAKE-LINE (N) ...)")
  (:message "Redefining MAKE-LINE in DEFUN"
   :severity :warning
   :location (:error "No error location available.")))
 t 0.372 t "/tmp/scratch.fasl")`;

/** A compile that failed: notes, no fasl, nothing for the loader to do. */
const COMPILE_FAILED = `(:compilation-result
 ((:message "Illegal function call: (1 2 3)"
   :severity :error
   :location (:location (:file "/tmp/broken.lisp") (:position 87) nil)))
 nil 0.021 t nil)`;

/** The quiet case: a fasl and not one note, with load never requested. */
const COMPILE_CLEAN = `(:compilation-result nil t 0.008 nil "/tmp/clean.fasl")`;

// ---- parseCompilationResult ----

Deno.test("parseCompilationResult - successp, duration, load flag, and fasl", () => {
  const result = parseCompilationResult(read(COMPILE_OK));
  assertEquals(result.successp, true);
  assertEquals(result.duration, 0.372);
  assertEquals(result.loadRequested, true);
  assertEquals(result.faslfile, "/tmp/scratch.fasl");
});

Deno.test("parseCompilationResult - a note keeps its location, snippet, and context", () => {
  const [note] = parseCompilationResult(read(COMPILE_OK)).notes;
  assertEquals(note, {
    severity: "style-warning",
    message: "Undefined function GEN-REPEAT",
    location: "/tmp/scratch.lisp:12",
    snippet: "(defun make-line (n)",
    context: "(DEFUN MAKE-LINE (N) ...)",
  });
});

Deno.test("parseCompilationResult - a note Slynk could not place has no location", () => {
  const note = parseCompilationResult(read(COMPILE_OK)).notes[1];
  assertEquals(note, { severity: "warning", message: "Redefining MAKE-LINE in DEFUN" });
});

Deno.test("parseCompilationResult - a failed compile has no fasl to load", () => {
  const result = parseCompilationResult(read(COMPILE_FAILED));
  assertEquals(result.successp, false);
  assertEquals(result.faslfile, undefined);
  assertEquals(result.notes.map((n) => n.severity), ["error"]);
  assertEquals(result.notes[0]!.location, "/tmp/broken.lisp @87");
});

Deno.test("parseCompilationResult - nil notes and nil load-p", () => {
  const result = parseCompilationResult(read(COMPILE_CLEAN));
  assertEquals(result.notes, []);
  assertEquals(result.loadRequested, false);
  assertEquals(result.successp, true);
});

// ---- formatCompilationResult ----

Deno.test("formatCompilationResult - loaded: status, load line, then every note", () => {
  const result = parseCompilationResult(read(COMPILE_OK));
  const out = formatCompilationResult("/tmp/scratch.lisp", result, {
    kind: "loaded",
    fasl: "/tmp/scratch.fasl",
  });
  assertStringIncludes(out, "Compiled /tmp/scratch.lisp (0.372s)");
  assertStringIncludes(out, "Loaded /tmp/scratch.fasl");
  assertStringIncludes(out, "Compiler notes (2):");
  assertStringIncludes(
    out,
    "  style-warning at /tmp/scratch.lisp:12\n" +
      "    Undefined function GEN-REPEAT\n" +
      "    in: (DEFUN MAKE-LINE (N) ...)",
  );
  // The second note placed nowhere, so it renders without an `at` clause.
  assertStringIncludes(out, "  warning\n    Redefining MAKE-LINE in DEFUN");
});

Deno.test("formatCompilationResult - failed load keeps the compiler notes", () => {
  const result = parseCompilationResult(read(COMPILE_OK));
  const out = formatCompilationResult("/tmp/scratch.lisp", result, {
    kind: "failed",
    fasl: "/tmp/scratch.fasl",
  });
  assertStringIncludes(out, "Compiled /tmp/scratch.lisp (0.372s)");
  assertStringIncludes(out, "Load FAILED for /tmp/scratch.fasl");
  assertStringIncludes(out, "Compiler notes (2):");
});

Deno.test("formatCompilationResult - not requested names the fasl it left alone", () => {
  const result = parseCompilationResult(read(COMPILE_CLEAN));
  const out = formatCompilationResult("/tmp/clean.lisp", result, { kind: "not-requested" });
  assertEquals(
    out,
    "Compiled /tmp/clean.lisp (0.008s)\n" +
      "Not loaded (load was false): /tmp/clean.fasl\n" +
      "No compiler notes.",
  );
});

Deno.test("formatCompilationResult - a failed compile produced nothing to load", () => {
  const result = parseCompilationResult(read(COMPILE_FAILED));
  const out = formatCompilationResult("/tmp/broken.lisp", result, { kind: "nothing-to-load" });
  assertStringIncludes(out, "Compile FAILED for /tmp/broken.lisp (0.021s)");
  assertStringIncludes(out, "Not loaded: the compile produced no fasl.");
  assertStringIncludes(out, "  error at /tmp/broken.lisp @87\n    Illegal function call: (1 2 3)");
});
