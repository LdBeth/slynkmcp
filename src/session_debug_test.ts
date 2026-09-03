/**
 * End-to-end session tests against a scripted fake Slynk speaking the real wire
 * protocol over loopback TCP, so the whole path is exercised — `:debug`
 * attribution by pending-continuation id, source-location collection while the
 * call is parked, restart choice, the report that comes back out of `eval`, and
 * the fasl load that `slynk:compile-file-for-emacs` leaves to its client.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Session } from "./session.ts";
import { SlynkDebugError } from "./slynk/debug.ts";
import { encodeFrame, readFrames } from "./slynk/framing.ts";
import { asList, print, read, type Sexp, Sym, text } from "./slynk/sexp.ts";

const CONDITION = `("Arithmetic error DIVISION-BY-ZERO signalled.
Operation was (/ 1 0)." "   [Condition of type DIVISION-BY-ZERO]" nil)`;

/** Slynk's own transport frame, as LispWorks prints it. */
const SLYNK_FRAME = `((harlequin-common-lisp:subfunction 1 ` +
  `(harlequin-common-lisp:subfunction 1 slynk:interactive-eval)))`;

/**
 * The stack shaped the way the field report had it: the host's error machinery
 * and Slynk's own frames innermost, the caller's code only below them.
 */
const FRAMES = `((0 "(SYSTEM::DIVISION-BY-ZERO-ERROR 1 0)" (:restartable nil))
                 (1 "${SLYNK_FRAME}" (:restartable nil))
                 (2 "(RATIO-OF 1 0)" (:restartable t))
                 (3 "(OM::MAKE-LINE 4)" (:restartable nil)))`;

/**
 * The stack from the live LispWorks report: `error` and `signal` print bare,
 * because the default package inherits `common-lisp`, so nothing in the printed
 * text tells them from the caller's own `MANGLE` until their home package is
 * looked up. Judging by the printed text alone headlined frame 0 as user code.
 */
const FRAMES_BARE_CL = `((0 "(error #<undefined-function 4020015B7B>)" (:restartable nil))
    (1 "(signal #<undefined-function 4020015B7B>)" (:restartable nil))
    (2 "(MANGLE (1 2 3))" (:restartable t))
    (3 "(OM::MAKE-LINE 4)" (:restartable nil)))`;

/** Same stack, but Slynk's frame printer blew up on the caller's inner frame. */
const FRAMES_UNPRINTABLE = `((0 "(SYSTEM::DIVISION-BY-ZERO-ERROR 1 0)" (:restartable nil))
                             (1 "${SLYNK_FRAME}" (:restartable nil))
                             (2 "[error printing frame]" (:restartable t))
                             (3 "(OM::MAKE-LINE 4)" (:restartable nil)))`;

/** An anonymous form typed at `lisp_eval`: nothing on the stack is the caller's. */
const FRAMES_ALL_INFRASTRUCTURE = `((0 "(SYSTEM::DIVISION-BY-ZERO-ERROR 1 0)" (:restartable nil))
    (1 "(CONDITIONS::SIGNAL-CONDITION #<DIVISION-BY-ZERO 200A3F>)" (:restartable nil))
    (2 "(SLYNK::CALL-WITH-RETRY-RESTART #<Closure 1>)" (:restartable nil))
    (3 "${SLYNK_FRAME}" (:restartable nil)))`;

/** Restart lists differing only in whether Slynk marked a quit restart. */
const RESTARTS_WITH_QUIT = `(("*ABORT" "Return to SLY's top level.") ("ABORT" "abort thread"))`;
const RESTARTS_WITHOUT_QUIT = `(("CONTINUE" "Retry the computation.") ("ABORT" "abort thread"))`;

/**
 * `slynk:frame-source-location` payload keyed by frame index. Frames not listed
 * answer `(:error …)`, exactly as Slynk does for a frame it can't place.
 */
type SourcesByFrame = Record<number, string>;

/**
 * Every frame here places, host and Slynk frames included — that is the trap:
 * `slynk:interactive-eval` really does live in a file on disk, so a probe that
 * doesn't skip it reports the bridge as the error source.
 */
const SOURCES: SourcesByFrame = {
  0: `(:location (:file "/usr/lib/lispworks/src/conditions.lisp") (:line 88) nil)`,
  1: `(:location (:file "/usr/share/sly/slynk/slynk.lisp") (:line 1103) nil)`,
  2: `(:location (:file "/tmp/scratch.lisp") (:line 42) (:snippet "(defun ratio-of (a b)"))`,
  3: `(:location (:file "/tmp/scratch.lisp") (:line 7) (:snippet "(defun make-line (n)"))`,
};

/**
 * Home package per frame head, the answer to the batched `find-symbol` rex.
 * Keyed by the head as the backtrace prints it; a head absent from the map
 * answers nil, exactly as `find-symbol` does for a symbol the package can't
 * see.
 */
type PackagesByHead = Record<string, string>;

/** The `FRAMES` stack as the live image resolves it. */
const PACKAGES: PackagesByHead = {
  "SYSTEM::DIVISION-BY-ZERO-ERROR": "SYSTEM",
  "harlequin-common-lisp:subfunction": "HARLEQUIN-COMMON-LISP",
  "RATIO-OF": "OPUSMODUS",
  "OM::MAKE-LINE": "OPUSMODUS",
};

/** The `FRAMES_BARE_CL` stack: two bare heads that are really `common-lisp`. */
const PACKAGES_BARE_CL: PackagesByHead = {
  error: "COMMON-LISP",
  signal: "COMMON-LISP",
  MANGLE: "OPUSMODUS",
  "OM::MAKE-LINE": "OPUSMODUS",
};

/** `SYSTEM::DIVISION-BY-ZERO-ERROR` → `DIVISION-BY-ZERO-ERROR`, upcased. */
function symbolName(head: string): string {
  const colon = head.indexOf(":");
  return (colon > 0 ? head.slice(colon).replace(/^:+/, "") : head).toUpperCase();
}

/** Dig the symbol name out of one `(cl:ignore-errors (cl:and (cl:find-symbol …) …))`. */
function lookupName(lookup: Sexp): string {
  const and = asList(asList(lookup, "ignore-errors")[1]!, "and");
  return text(asList(and[1]!, "find-symbol")[1]);
}

/**
 * `(:compilation-result NOTES SUCCESSP DURATION LOADP FASLFILE)`. LOADP is only
 * echoed back — `slynk-compile-file*` passes `nil` for the backend's own
 * `load-p` and never loads the fasl, whatever the client asked for.
 */
type Compilation = (loadp: string) => string;

const COMPILED: Compilation = (loadp) =>
  `(:compilation-result nil t 0.031 ${loadp} "/tmp/scratch.fasl")`;

const COMPILE_FAILED: Compilation = (loadp) =>
  `(:compilation-result ((:message "Illegal function call: (1 2 3)"
                          :severity :error
                          :location (:location (:file "/tmp/broken.lisp") (:line 3) nil)))
    nil 0.004 ${loadp} nil)`;

interface FakeOptions {
  restarts?: string;
  frames?: string;
  sources?: SourcesByFrame;
  packages?: PackagesByHead;
  compilation?: Compilation;
}

class FakeSlynk {
  readonly port: number;
  /** Names of the RPCs the client sent, in order. */
  readonly calls: string[] = [];
  /** Symbol names of the batched home-package lookup, in the order asked. */
  readonly packageLookups: string[] = [];
  /** Frame indices the client asked a source location for, in order. */
  readonly sourceProbes: number[] = [];
  /** Files the client asked `slynk:load-file` to load, in order. */
  readonly loadCalls: string[] = [];
  /** Arguments of the `invoke-nth-restart-for-emacs` call, if any. */
  restartArgs: Sexp[] | null = null;
  /** Arguments of the `compile-file-for-emacs` call, if any. */
  compileArgs: Sexp[] | null = null;

  readonly #restarts: string;
  readonly #frames: string;
  readonly #sources: SourcesByFrame;
  /** The `packages` option, re-keyed the way `find-symbol` will ask for them. */
  readonly #packages = new Map<string, string>();
  readonly #compilation: Compilation;
  #listener: Deno.Listener;
  #task: Promise<void>;
  #conn: Deno.Conn | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #evalId = 0;

  constructor(opts: FakeOptions = {}) {
    this.#restarts = opts.restarts ?? RESTARTS_WITH_QUIT;
    this.#frames = opts.frames ?? FRAMES;
    this.#sources = opts.sources ?? SOURCES;
    for (const [head, pkg] of Object.entries(opts.packages ?? PACKAGES)) {
      this.#packages.set(symbolName(head), pkg);
    }
    this.#compilation = opts.compilation ?? COMPILED;
    this.#listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    this.port = (this.#listener.addr as Deno.NetAddr).port;
    this.#task = this.#serve();
  }

  async close(): Promise<void> {
    try {
      this.#listener.close();
    } catch { /* already closed */ }
    try {
      this.#conn?.close();
    } catch { /* already closed */ }
    await this.#task;
  }

  async #serve(): Promise<void> {
    let conn: Deno.Conn;
    try {
      conn = await this.#listener.accept();
    } catch {
      return; // closed before anyone connected
    }
    this.#conn = conn;
    this.#writer = conn.writable.getWriter();
    try {
      for await (const frame of readFrames(conn.readable)) {
        await this.#handle(read(frame));
      }
    } catch { /* connection torn down by the test */ }
  }

  #send(s: string): Promise<void> {
    return this.#writer!.write(encodeFrame(s));
  }

  async #handle(event: Sexp): Promise<void> {
    // (:emacs-rex FORM PKG THREAD ID)
    const parts = asList(event, "rex");
    const form = asList(parts[1]!, "form");
    const id = parts[4] as number;
    const op = form[0] instanceof Sym ? form[0].name : "";
    this.calls.push(op);

    switch (op) {
      case "slynk:interactive-eval":
        this.#evalId = id;
        await this.#send(`(:write-string "computing…" :repl-result)`);
        await this.#send(
          `(:debug 6 1 ${CONDITION} ${this.#restarts} ${this.#frames} (${id}))`,
        );
        await this.#send(`(:debug-activate 6 1 nil)`);
        return;

      // The batched home-package lookup: one `find-symbol` chain per distinct
      // frame head, answered positionally with a package name or nil.
      // the eval rex stays parked until a restart is invoked
      case "cl:list": {
        const names = form.slice(1).map(lookupName);
        this.packageLookups.push(...names);
        const answers = names.map((n) => {
          const pkg = this.#packages.get(n);
          return pkg === undefined ? "nil" : `"${pkg}"`;
        });
        await this.#ok(id, `(${answers.join(" ")})`);
        return;
      }

      case "slynk:frame-source-location": {
        const frame = form[1] as number;
        this.sourceProbes.push(frame);
        await this.#ok(id, this.#sources[frame] ?? `(:error "No source for frame")`);
        return;
      }

      case "slynk:invoke-nth-restart-for-emacs":
        this.restartArgs = form.slice(1);
        await this.#ok(id, "nil");
        await this.#send(`(:debug-return 6 1 nil)`);
        await this.#send(
          `(:return (:abort "#<DIVISION-BY-ZERO {1005}>") ${this.#evalId})`,
        );
        return;

      case "slynk:compile-file-for-emacs":
        this.compileArgs = form.slice(1);
        // The LOADP field is the flag coming straight back; no load happens.
        await this.#ok(id, this.#compilation(print(form[2] ?? [])));
        return;

      case "slynk:load-file":
        this.loadCalls.push(text(form[1]));
        await this.#ok(id, "t");
        return;

      default:
        // connection-info, slynk-require, create-mrepl, anything else.
        await this.#ok(id, "nil");
    }
  }

  #ok(id: number, value: string): Promise<void> {
    return this.#send(`(:return (:ok ${value}) ${id})`);
  }
}

async function withSession(
  fn: (session: Session, server: FakeSlynk) => Promise<void>,
  opts: FakeOptions & { debugSources?: number } = {},
): Promise<void> {
  const server = new FakeSlynk(opts);
  const session = new Session({
    host: "127.0.0.1",
    port: server.port,
    defaultPackage: "cl-user",
    // Match the fixture so no extra `slynk:backtrace` round trip is needed.
    debugFrames: 4,
    debugSources: opts.debugSources ?? 2,
  });
  try {
    await fn(session, server);
  } finally {
    await session.stop();
    await server.close();
  }
}

async function evalError(session: Session): Promise<SlynkDebugError> {
  try {
    await session.eval("(/ 1 0)");
  } catch (e) {
    assert(e instanceof SlynkDebugError, `expected SlynkDebugError, got ${e}`);
    return e;
  }
  throw new Error("eval resolved, expected a debugger error");
}

Deno.test("eval error - report leads with the source location, then output and stack", async () => {
  await withSession(async (session, server) => {
    const report = (await evalError(session)).report();

    assertEquals(server.sourceProbes, [2, 3]);
    assertStringIncludes(report, "[Condition of type DIVISION-BY-ZERO]");
    assertStringIncludes(report, "Operation was (/ 1 0).");
    assertStringIncludes(
      report,
      "Error source: /tmp/scratch.lisp:42\n" +
        "  frame 2 (RATIO-OF 1 0)\n" +
        "  (defun ratio-of (a b)",
    );
    assertStringIncludes(report, "Output before the error:\n  computing…");
    assertStringIncludes(report, "0 (SYSTEM::DIVISION-BY-ZERO-ERROR 1 0)");
    assertStringIncludes(report, "2 (RATIO-OF 1 0)\n      at /tmp/scratch.lisp:42");
    // Restarts drive the unwind but never reach the caller.
    assertEquals(report.includes("abort thread"), false);
    assertEquals(report.includes("Abort reason"), false);
  });
});

Deno.test("eval error - never spends a probe on a host or Slynk frame", async () => {
  await withSession(async (session, server) => {
    const report = (await evalError(session)).report();

    // Frames 0 and 1 both have real files behind them — `slynk.lisp` most of
    // all — so probing them would headline the bridge. The budget goes to the
    // caller's frames instead.
    assertEquals(server.sourceProbes, [2, 3]);
    assertEquals(report.includes("slynk.lisp"), false);
    assertEquals(report.includes("conditions.lisp"), false);
    assertStringIncludes(report, "Error source: /tmp/scratch.lisp:42");
  });
});

Deno.test("eval error - packages resolve, then locations, then the unwind", async () => {
  await withSession(async (session, server) => {
    await evalError(session);

    const debuggerCalls = server.calls.filter((c) =>
      c === "cl:list" || c.startsWith("slynk:frame") || c.includes("restart")
    );
    assertEquals(debuggerCalls, [
      "cl:list",
      "slynk:frame-source-location",
      "slynk:frame-source-location",
      "slynk:invoke-nth-restart-for-emacs",
    ]);
    // One rex for the whole stack, one lookup per distinct frame head.
    assertEquals(server.packageLookups, [
      "DIVISION-BY-ZERO-ERROR",
      "SUBFUNCTION",
      "RATIO-OF",
      "MAKE-LINE",
    ]);
    // debugFrames matches the frames Slynk volunteered, so no extra fetch.
    assertEquals(server.calls.includes("slynk:backtrace"), false);
  });
});

Deno.test("eval error - names the innermost application frame when nothing placed", async () => {
  await withSession(async (session, server) => {
    const report = (await evalError(session)).report();

    assertEquals(server.sourceProbes, [2, 3]);
    assertStringIncludes(
      report,
      "Error source: not recorded.\n" +
        "  Innermost application frame: 2 (RATIO-OF 1 0)\n" +
        "  None of the 2 probed frames has a source location.",
    );
    assertStringIncludes(report, "Compile your own code from a file with");
  }, { sources: {} });
});

Deno.test("eval error - a bare frame whose package is COMMON-LISP is still library", async () => {
  // The defect this replaced: `error` and `signal` print with no package
  // prefix, so the printed text alone made them look like the caller's own
  // code and the report headlined `1 (error #<undefined-function …>)`. Their
  // home package settles it, and the probe budget goes to MANGLE instead.
  await withSession(async (session, server) => {
    const report = (await evalError(session)).report();

    assertEquals(server.packageLookups, ["ERROR", "SIGNAL", "MANGLE", "MAKE-LINE"]);
    assertEquals(server.sourceProbes, [2, 3]);
    assertStringIncludes(
      report,
      "Error source: not recorded.\n" +
        "  Innermost application frame: 2 (MANGLE (1 2 3))\n" +
        "  None of the 2 probed frames has a source location.\n" +
        "  A form typed at lisp_eval has no file behind it, and library code shipped\n" +
        "  without source never places. Compile your own code from a file with\n" +
        "  lisp_compile_file and its frames place the failing call — though a caller\n" +
        "  that ends in the failing call may be gone anyway, since LispWorks drops\n" +
        "  tail calls.",
    );
  }, { frames: FRAMES_BARE_CL, packages: PACKAGES_BARE_CL, sources: {} });
});

Deno.test("eval error - an OPUSMODUS frame is probed and headlined", async () => {
  // OPUSMODUS is deliberately not infrastructure: the caller's definitions and
  // the library's share it, and only a source location tells them apart.
  await withSession(async (session, server) => {
    const report = (await evalError(session)).report();

    assertEquals(server.sourceProbes, [2, 3]);
    assertStringIncludes(
      report,
      "Error source: /tmp/mangle.lisp:12\n" +
        "  frame 2 (MANGLE (1 2 3))\n" +
        "  (defun mangle (xs)",
    );
    assertStringIncludes(report, "2 (MANGLE (1 2 3))\n      at /tmp/mangle.lisp:12");
  }, {
    frames: FRAMES_BARE_CL,
    packages: PACKAGES_BARE_CL,
    sources: {
      2: `(:location (:file "/tmp/mangle.lisp") (:line 12) (:snippet "(defun mangle (xs)"))`,
    },
  });
});

Deno.test("eval error - probes nothing when the whole stack is infrastructure", async () => {
  await withSession(async (session, server) => {
    const report = (await evalError(session)).report();

    assertEquals(server.sourceProbes, []);
    assertEquals(server.calls.includes("slynk:frame-source-location"), false);
    assertStringIncludes(
      report,
      "Error source: not recorded.\n" +
        "  No application frame on this stack: it is all host and Slynk internals.",
    );
    assertEquals(report.includes("Innermost application frame"), false);
    assertStringIncludes(report, "Compile your own code from a file with");
    // The stack is still reported; only the headline had nothing to name.
    assertStringIncludes(report, "2 (SLYNK::CALL-WITH-RETRY-RESTART #<Closure 1>)");
  }, { frames: FRAMES_ALL_INFRASTRUCTURE });
});

Deno.test("eval error - skips frames Slynk could not even print", async () => {
  await withSession(async (session, server) => {
    const report = (await evalError(session)).report();

    // Frame 2 printed as `[error printing frame]`; asking where it lives is a
    // wasted round trip, so only the caller's outer frame is probed.
    assertEquals(server.sourceProbes, [3]);
    assertStringIncludes(
      report,
      "Error source: /tmp/scratch.lisp:7\n  frame 3 (OM::MAKE-LINE 4)",
    );
    assertStringIncludes(report, "2 [error printing frame]");
  }, { frames: FRAMES_UNPRINTABLE });
});

Deno.test("eval error - debugSources 0 skips probing entirely", async () => {
  await withSession(async (session, server) => {
    const report = (await evalError(session)).report();

    assertEquals(server.sourceProbes, []);
    assertEquals(server.calls.includes("slynk:frame-source-location"), false);
    // Not even the package lookup: with nothing to probe there is nothing to
    // classify, so the batched rex is skipped too.
    assertEquals(server.calls.includes("cl:list"), false);
    assertStringIncludes(report, "Error source: not looked up (SLYNK_DEBUG_SOURCES is 0).");
    // The backtrace still comes through; only the locations are missing.
    assertStringIncludes(report, "2 (RATIO-OF 1 0)");
  }, { debugSources: 0 });
});

Deno.test("eval error - prefers the quit restart Slynk marked with `*`", async () => {
  await withSession(async (session, server) => {
    await evalError(session);
    // (level, index): index 0 is `*ABORT`, the restart that returns from the
    // RPC — not index 1, which aborts the worker thread.
    assertEquals(print(server.restartArgs as Sexp), "(1 0)");
  });
});

Deno.test("eval error - falls back to a plain ABORT when nothing is marked", async () => {
  await withSession(async (session, server) => {
    await evalError(session);
    assertEquals(print(server.restartArgs as Sexp), "(1 1)");
  }, { restarts: RESTARTS_WITHOUT_QUIT });
});

Deno.test("eval error - flags a backtrace that was cut short", async () => {
  await withSession(async (session) => {
    // The fixture has exactly as many frames as debugFrames allows.
    const report = (await evalError(session)).report();
    assertStringIncludes(report, "Backtrace (innermost 4 frames):");
    assertStringIncludes(report, "raise SLYNK_DEBUG_FRAMES");
  });
});

// ---- compile + load ----

Deno.test("compile file - loads the fasl, since Slynk itself never does", async () => {
  await withSession(async (session, server) => {
    const out = await session.compileFile("/tmp/scratch.lisp");

    assertEquals(print(server.compileArgs as Sexp), `("/tmp/scratch.lisp" t)`);
    // The whole point of the fix: a second rex, carrying the fasl the compile
    // reported, is what actually defines anything in the image.
    assertEquals(server.loadCalls, ["/tmp/scratch.fasl"]);
    assertStringIncludes(out, "Compiled /tmp/scratch.lisp (0.031s)");
    assertStringIncludes(out, "Loaded /tmp/scratch.fasl");
    assertStringIncludes(out, "No compiler notes.");
  });
});

Deno.test("compile file - load false compiles and stops there", async () => {
  await withSession(async (session, server) => {
    const out = await session.compileFile("/tmp/scratch.lisp", false);

    assertEquals(print(server.compileArgs as Sexp), `("/tmp/scratch.lisp" nil)`);
    assertEquals(server.loadCalls, []);
    assertEquals(server.calls.includes("slynk:load-file"), false);
    assertStringIncludes(out, "Not loaded (load was false): /tmp/scratch.fasl");
  });
});

Deno.test("compile file - a compile that produced no fasl is not loaded", async () => {
  await withSession(async (session, server) => {
    const out = await session.compileFile("/tmp/broken.lisp");

    assertEquals(server.loadCalls, []);
    assertEquals(server.calls.includes("slynk:load-file"), false);
    assertStringIncludes(out, "Compile FAILED for /tmp/broken.lisp (0.004s)");
    assertStringIncludes(out, "Not loaded: the compile produced no fasl.");
    assertStringIncludes(out, "  error at /tmp/broken.lisp:3");
  }, { compilation: COMPILE_FAILED });
});
