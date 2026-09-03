/**
 * High-level session: owns the SlynkClient, bootstraps the connection,
 * creates an mREPL channel, captures per-request output, and exposes a
 * convenient API for MCP tools.
 *
 * Output capture: Slynk's `:write-string` and channel-send messages arrive
 * asynchronously, not tied to a request id, so we can't perfectly attribute
 * them. To avoid cross-contamination, every Session-level rex is serialized
 * through `#queue`; the per-eval buffer is only set during `#evalOnce`, so
 * concurrent non-eval rex calls can never leak `:write-string` into an
 * eval's output. The one intentional exception is the debugger handling fired
 * from `onDebugActivate` (detail collection plus the auto-abort restart): it
 * bypasses the queue because it must run while the rex it's aborting is still
 * in flight, holding the queue.
 */

import { type RexOptions, SlynkClient } from "./slynk/client.ts";
import { formatCompilationResult, parseCompilationResult } from "./slynk/compilation.ts";
import {
  type DebugInfo,
  describeError,
  formatSourceLocation,
  frameHead,
  frameOrigin,
  parseBacktrace,
  SlynkDebugError,
  UNPRINTABLE_FRAME,
} from "./slynk/debug.ts";
import { OnceAsync } from "./once_async.ts";
import { type Handle, HandleStore, maybeTruncate } from "./handles.ts";
import {
  asList,
  isList,
  plistEntries,
  print,
  type Sexp,
  sym,
  T,
  tagName,
  text,
} from "./slynk/sexp.ts";
/**
 * Ceiling on one debugger-introspection rex. Collection runs while a tool call
 * is parked in the debugger, so a backend that stops answering must not hold
 * that call open: the first timeout gives up on the report and unwinds.
 */
const DEBUG_RPC_TIMEOUT_MS = 5000;

export interface SessionOptions {
  host: string;
  port: number;
  defaultPackage: string;
  /** Backtrace frames to report on a Lisp error. Default 32. */
  debugFrames?: number;
  /** Innermost frames to ask a source location for. 0 disables probing. Default 8. */
  debugSources?: number;
}

/**
 * Thrown when swankmcp can't open a TCP connection to Slynk on the configured
 * host/port. The message tells the user how to fix it; tool handlers surface
 * this verbatim instead of a generic stack trace.
 */
export class SlynkUnreachableError extends Error {
  constructor(host: string, port: number, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Slynk not reachable on ${host}:${port} — start the Lisp image and run ` +
        `(slynk:create-server :port ${port} :dont-close t) ` +
        `[underlying error: ${reason}]`,
    );
    this.name = "SlynkUnreachableError";
    this.cause = cause;
  }
}

export interface ConnectionInfo {
  pid: number;
  lisp: { type: string; name: string; version: string };
  machine: { instance: string; type: string };
  features: string[];
  packageName: string;
  prompt: string;
  /* version: string; */
  raw: Sexp;
}

export interface EvalResult {
  /** Printed result (the value Lisp returned, as a string). */
  value: string;
  /** Captured stdout / mREPL output during the call. */
  print?: string;
}

export class Session {
  #client: SlynkClient;
  public defaultPackage: string;
  #store = new HandleStore();

  readonly #host: string;
  readonly #port: number;
  readonly #connectGate = new OnceAsync<ConnectionInfo>();
  /** Currently-capturing output buffer (set only during `#evalOnce`). */
  #captureBuf: string[] | null = null;
  /** Mutex queue serializing every Session-level rex call. */
  #queue: Promise<unknown> = Promise.resolve();
  readonly #debugFrames: number;
  readonly #debugSources: number;
  /** Guards against recursing into detail collection from a nested debugger. */
  #collectingDebug = false;
  constructor(opts: SessionOptions) {
    this.defaultPackage = opts.defaultPackage;
    this.#host = opts.host;
    this.#port = opts.port;
    this.#debugFrames = opts.debugFrames ?? 32;
    this.#debugSources = opts.debugSources ?? 8;
    this.#client = new SlynkClient({
      onWriteString: (text) => {
        if (this.#captureBuf) this.#captureBuf.push(text);
      },
      onChannelSend: (_cid, msg) => {
        // mREPL sends (:write-values ...) and (:write-string TEXT) channel msgs
        if (!isList(msg) || msg.length === 0) return;
        const tag = tagName(msg[0]);
        if (!tag) return;
        if (tag === "write-string" && typeof msg[1] === "string") {
          if (this.#captureBuf) this.#captureBuf.push(msg[1]);
        }
        // Other channel messages (:prompt, :evaluation-aborted) are diagnostic;
        // we surface eval status via the rex return value, not the channel.
      },
      onDebugActivate: (info) => {
        void this.#handleDebug(info);
      },
      onDisconnect: () => {
        this.#connectGate.reset();
        this.#captureBuf = null;
      },
    });
  }

  // ---- Debugger (collect, then auto-abort) ----

  /**
   * Every debugger entry is unwound — swankmcp has no interactive debugger.
   * But the stack only exists until we unwind, so first ask where the innermost
   * frames live and hang the answers on `info`; the client already holds `info`
   * and attaches it to the rex rejection, so the caller gets a located error
   * instead of a one-line condition.
   *
   * Collection deliberately bypasses `#queue`: the queue is held by the very
   * call parked in the debugger, and Slynk's sly-db loop keeps serving
   * `:emacs-rex` on the debugger's own thread while it waits.
   */
  async #handleDebug(info: DebugInfo): Promise<void> {
    // A detail rex that itself errors opens a nested level; abort that one
    // immediately rather than recursing into collection for it.
    if (!this.#collectingDebug) {
      this.#collectingDebug = true;
      try {
        await this.#collectDebugDetails(info);
      } catch (err) {
        console.error("swankmcp: debugger detail collection failed:", err);
      } finally {
        this.#collectingDebug = false;
      }
    }
    this.#abortDebug(info);
  }

  async #collectDebugDetails(info: DebugInfo): Promise<void> {
    // Slynk's `:debug` event carries *sly-db-initial-frames* (20) frames; ask
    // for more when configured above that, and trim when configured below.
    if (this.#debugFrames > info.frames.length) {
      const raw = await this.#debugRex(
        info,
        [sym("slynk:backtrace"), 0, this.#debugFrames],
      );
      const frames = raw === null ? [] : parseBacktrace(raw);
      if (frames.length > 0) info.frames = frames;
    } else if (this.#debugFrames < info.frames.length) {
      info.frames = info.frames.slice(0, this.#debugFrames);
    }
    // A full page of frames means the stack probably continues below the cut.
    info.framesTruncated = info.frames.length >= this.#debugFrames;

    if (this.#debugSources < 1) return;
    await this.#resolveFramePackages(info);
    await this.#locateFrames(info);
  }

  /**
   * Look up the home package of each frame's function, in one batched rex.
   *
   * A Lisp omits the package prefix for any symbol accessible in `*package*`,
   * so with a default package of `om` — which inherits `common-lisp` — the
   * frame for `common-lisp:error` prints as bare `error`, exactly like a user's
   * own function. Judging by printed text alone therefore let host frames
   * through and named them as the caller's code. `find-symbol` settles it.
   *
   * `find-symbol` rather than `read-from-string`: reading would intern every
   * junk token from the backtrace into the user's package.
   */
  async #resolveFramePackages(info: DebugInfo): Promise<void> {
    const heads = new Map<string, Sexp>();
    for (const frame of info.frames) {
      const head = frameHead(frame.description);
      if (head && !heads.has(head)) heads.set(head, homePackageForm(head, this.defaultPackage));
    }
    if (heads.size === 0) {
      info.packagesResolved = true;
      return;
    }

    const raw = await this.#debugRex(info, [sym("cl:list"), ...heads.values()]);
    if (raw === null || !isList(raw)) return;

    const resolved = new Map<string, string>();
    let i = 0;
    for (const head of heads.keys()) {
      const name = raw[i++];
      if (typeof name === "string" && name.length > 0) resolved.set(head, name);
    }
    for (const frame of info.frames) {
      const head = frameHead(frame.description);
      const pkg = head === undefined ? undefined : resolved.get(head);
      if (pkg) frame.package = pkg;
    }
    info.packagesResolved = true;
  }

  /**
   * Ask Slynk where the innermost frames live. This is the point of the whole
   * report: a condition tells the caller what broke, a file and line tells them
   * where to go.
   *
   * Only the caller's own frames are asked. Host and Slynk frames do have
   * locations — every eval runs through `slynk:interactive-eval`, whose source
   * file is right there on disk — so probing them would spend the budget to
   * report that the error is inside the bridge. Skipping them spends it on
   * frames that can actually answer the question.
   */
  async #locateFrames(info: DebugInfo): Promise<void> {
    let probed = 0;
    for (const frame of info.frames) {
      if (probed >= this.#debugSources) break;
      // A frame whose printer already failed won't place either.
      if (frame.description === UNPRINTABLE_FRAME) continue;
      if (frameOrigin(frame) === "library") continue;
      probed++;
      const raw = await this.#debugRex(
        info,
        [sym("slynk:frame-source-location"), frame.index],
      );
      const where = raw === null ? undefined : formatSourceLocation(raw);
      if (where) {
        frame.source = where.where;
        if (where.snippet) frame.snippet = where.snippet;
      }
    }
    info.sourceProbeDepth = probed;
  }

  /**
   * One introspection rex against the thread sitting in the debugger. A backend
   * that lacks the RPC (or chokes on a frame) answers with an abort; that's a
   * missing report line, not a failure, so it resolves to null. A backend that
   * doesn't answer at all is a failure — it throws, and the caller stops
   * collecting and unwinds.
   */
  async #debugRex(info: DebugInfo, form: Sexp): Promise<Sexp | null> {
    // `ReturnType`, not `number`: the npm SDK drags Node's `Timeout` in.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = Symbol("timeout");
    try {
      const result = await Promise.race([
        this.#client.rex(form, { pkg: this.defaultPackage, thread: info.thread })
          .catch(() => null),
        new Promise<symbol>((resolve) => {
          timer = setTimeout(() => resolve(expired), DEBUG_RPC_TIMEOUT_MS);
        }),
      ]);
      if (result === expired) {
        throw new Error(`debugger did not answer ${print(form)} within ${DEBUG_RPC_TIMEOUT_MS}ms`);
      }
      return result as Sexp | null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Leave the debugger. The restart list is never shown to the caller — no tool
   * can invoke one — but picking the right restart still matters. Slynk marks
   * the rex-level `abort` restart (`*sly-db-quit-restart*`) with a `*` prefix,
   * and that one returns from the RPC; a bare `ABORT` further down the list
   * usually aborts the whole worker thread. Prefer the marked restart, then a
   * plain ABORT, then the last.
   */
  #abortDebug(info: DebugInfo): void {
    const restart = info.restarts.find((r) => r.quit) ??
      info.restarts.find((r) => /^abort$/i.test(r.name)) ??
      info.restarts[info.restarts.length - 1];
    if (!restart) return;
    this.#client.rex(
      [sym("slynk:invoke-nth-restart-for-emacs"), info.level, restart.index],
      { thread: info.thread },
    ).catch(() => {});
  }

  // ---- Handle store (truncation cache for oversized tool results) ----

  truncate(kind: string, text: string, maxChars: number): string {
    return maybeTruncate(this.#store, kind, text, maxChars).text;
  }

  getHandle(id: string): Handle | undefined {
    return this.#store.get(id);
  }

  listHandles(): Handle[] {
    return this.#store.list();
  }

  /**
   * Open the TCP connection to Slynk and bootstrap mREPL on first call.
   * Concurrent callers share a single connect attempt. On failure, state is
   * reset so a later call can retry. Subsequent calls are no-ops while the
   * connection is alive.
   */
  // Kept as a one-line wrapper (rather than inlined at the two call sites)
  // purely to shrink the minified JS: a private `#ensureConnected()` call site
  // mangles smaller than repeating `await this.getConnectionInfo()`.
  async #ensureConnected(): Promise<void> {
    await this.getConnectionInfo();
  }

  /** Resolve cached connection info, connecting on demand. */
  getConnectionInfo(): Promise<ConnectionInfo> {
    return this.#connectGate.run(() => this.#bootstrap());
  }

  async #bootstrap(): Promise<ConnectionInfo> {
    try {
      await this.#client.connect(this.#host, this.#port);
    } catch (err) {
      throw new SlynkUnreachableError(this.#host, this.#port, err);
    }

    try {
      const info = await this.#client.rex([sym("slynk:connection-info")]);
      const parsed = parseConnectionInfo(info);

      await this.#client.rex(
        [
          sym("slynk:slynk-require"),
          [
            sym("quote"),
            [sym("slynk/mrepl"), sym("slynk/indentation"), sym("slynk/apropos")],
          ],
        ],
      ).catch(() => {/* contribs may already be loaded */});

      await this.#client.rex(
        [sym("slynk-mrepl:create-mrepl"), 0],
        { pkg: this.defaultPackage },
      ).catch(() => null);

      return parsed;
    } catch (err) {
      // Bootstrap failed after the socket opened — tear it down so the next
      // call attempts a fresh connection instead of reusing a wedged one.
      await this.#client.close().catch(() => {});
      throw err;
    }
  }

  async stop(): Promise<void> {
    await this.#client.close();
  }

  #runQueued<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(fn, fn);
    this.#queue = next.catch(() => {});
    return next;
  }

  /** Connect (if needed) then dispatch an rex, serialized through `#queue`. */
  async #rex(form: Sexp, opts: RexOptions = {}): Promise<Sexp> {
    await this.#ensureConnected();
    return this.#runQueued(() => this.#client.rex(form, { pkg: this.defaultPackage, ...opts }));
  }

  public rex(form: Sexp) {
    return this.#rex(form);
  }

  #rexStr(form: Sexp): Promise<string> {
    return this.#rex(form).then(print);
  }

  // `str` coerces nil→"" and :not-available→":not-available"; `print` would
  // render nil as "nil", losing the "nothing to show" signal.
  #rexDisplay(form: Sexp): Promise<string> {
    return this.#rex(form).then(text);
  }

  /**
   * Eval a string in the session's default package, capturing stdout.
   * Errors are auto-aborted from the debugger and rejected as a
   * `SlynkDebugError` carrying the condition, restarts, and backtrace.
   */
  async eval(code: string, pkg?: string): Promise<EvalResult> {
    await this.#ensureConnected();
    const p = pkg ?? this.defaultPackage;
    return this.#runQueued(() => this.#evalOnce(code, p));
  }

  async #evalOnce(code: string, pkg: string): Promise<EvalResult> {
    const buf: string[] = [];
    this.#captureBuf = buf;
    try {
      const value = await this.#client.rex(
        [sym("slynk:interactive-eval"), code],
        { pkg },
      ) as string;
      return { value, ...(buf.length > 0 ? { print: buf.join("") } : {}) };
    } catch (e) {
      // Whatever the form printed before it broke is part of the evidence, so
      // carry it into the error report instead of dropping it on the floor.
      if (e instanceof SlynkDebugError && buf.length > 0) e.output = buf.join("");
      throw e;
    } finally {
      this.#captureBuf = null;
    }
  }

  // -------------------------------------------------------------------
  // Convenience wrappers
  // -------------------------------------------------------------------

  /**
   * Compile a file and, when asked, load the fasl.
   *
   * The load is ours to do: `slynk:compile-file-for-emacs` never loads, it only
   * echoes `load-p` back in its result (see `compilation.ts`). Before this the
   * tool reported success while defining nothing, and the caller met an
   * undefined-function error on the next call.
   */
  async compileFile(path: string, load = true): Promise<string> {
    const result = parseCompilationResult(
      await this.#rex([sym("slynk:compile-file-for-emacs"), path, load ? T : []]),
    );
    const fasl = result.successp ? result.faslfile : undefined;
    if (!load) return formatCompilationResult(path, result, { kind: "not-requested" });
    if (!fasl) return formatCompilationResult(path, result, { kind: "nothing-to-load" });

    try {
      await this.#rex([sym("slynk:load-file"), fasl]);
    } catch (err) {
      // The compiler notes explain the load failure often enough that losing
      // them would be worse than losing the error's own shape.
      throw new Error(
        `${formatCompilationResult(path, result, { kind: "failed", fasl })}\n\n` +
          `${describeError(err)}`,
      );
    }
    return formatCompilationResult(path, result, { kind: "loaded", fasl });
  }

  loadFile(path: string): Promise<string> {
    return this.#rexStr(
      [sym("slynk:load-file"), path],
    );
  }

  async completions(prefix: string, pkg?: string): Promise<string[]> {
    const p = pkg ?? this.defaultPackage;
    const result = await this.#rex(
      [sym("slynk:simple-completions"), prefix, p],
      { pkg: p },
    );
    if (!isList(result) || !isList(result[0])) return [];
    return (result[0] as Sexp[]).filter((x): x is string => typeof x === "string");
  }

  aproposRaw(pattern: string, externalOnly = true): Promise<Sexp> {
    return this.#rex(
      [
        sym("slynk-apropos:apropos-list-for-emacs"),
        pattern,
        externalOnly ? T : [],
        [],
        [],
      ],
    );
  }

  apropos(pattern: string, externalOnly = true): Promise<string> {
    return this.aproposRaw(pattern, externalOnly).then(print);
  }

  // Slynk's introspection RPCs return a string in the common case but may
  // return nil / :not-available / an empty list for unknown symbols. Coerce
  // through `str()` so callers always see a string (nil → "").

  describe(symbolName: string): Promise<string> {
    return this.#rexDisplay(
      [sym("slynk:describe-symbol"), symbolName],
    );
  }

  documentation(symbolName: string): Promise<string> {
    return this.#rexDisplay(
      [sym("slynk:documentation-symbol"), symbolName],
    );
  }

  arglist(symbolName: string): Promise<string> {
    return this.#rexDisplay(
      [sym("slynk:operator-arglist"), symbolName, this.defaultPackage],
    );
  }

  macroexpand(form: string, all = false): Promise<string> {
    const op = all ? "slynk:slynk-macroexpand-all" : "slynk:slynk-macroexpand-1";
    return this.#rexDisplay([sym(op), form]);
  }

  findDefinition(symbolName: string): Promise<string> {
    return this.#rexDisplay(
      [sym("slynk:find-definitions-for-emacs"), symbolName],
    );
  }

  // ---- Inspector ----

  inspect(expression: string): Promise<string> {
    return this.#rexStr(
      [sym("slynk:init-inspector"), expression],
    );
  }
  inspectorPart(index: number): Promise<string> {
    return this.#rexStr(
      [sym("slynk:inspect-nth-part"), index],
    );
  }
  inspectorPop(): Promise<string> {
    return this.#rexStr([sym("slynk:inspector-pop")]);
  }
  inspectorReinspect(): Promise<string> {
    return this.#rexStr([sym("slynk:inspector-reinspect")]);
  }

  /**
   * Send `:emacs-interrupt` to the REPL thread. No-op if not currently
   * connected.
   *
   * Limitation: targets the hardcoded `:repl-thread` rather than the actual
   * thread running the in-flight eval. `slynk:interactive-eval` is dispatched
   * to a Slynk-picked worker (thread=t) which is typically NOT `:repl-thread`,
   * so this may not actually interrupt the running computation. Fix would
   * require tracking the worker thread id from the rex's `:debug` / `:return`
   * events. Not a regression — matches prior behavior.
   */
  interrupt(): void {
    if (!this.#client.isConnected) return;
    this.#client.interrupt(":repl-thread");
  }
}

function parseConnectionInfo(info: Sexp): ConnectionInfo {
  // Slynk returns a property list: (:pid N :lisp-implementation (...) ...)
  const plist = asList(info, "connection-info");
  // Five keys are read from this same top-level plist below; build one lookup
  // table in a single pass instead of re-scanning `plist` per key.
  const table = new Map(plistEntries(plist));

  function plistGet(plist: Sexp[], k: string): Sexp {
    for (const [name, val] of plistEntries(plist)) {
      if (name === k) return val;
    }
    return [];
  }

  function plistStr(plist: Sexp[], k: string): string {
    return plistGet(plist, k) as string;
  }

  const lispImpl = asList(table.get("lisp-implementation") ?? [], "lisp-implementation");
  const machine = asList(table.get("machine") ?? [], "machine");
  const features = asList(table.get("features") ?? [], "features");
  const pkgInfo = asList(table.get("package") ?? [], "package");
  const pid = table.get("pid") ?? [];

  return {
    pid: typeof pid === "number" ? pid : 0,
    lisp: {
      type: plistStr(lispImpl, "type"),
      name: plistStr(lispImpl, "name"),
      version: plistStr(lispImpl, "version"),
    },
    machine: { instance: plistStr(machine, "instance"), type: plistStr(machine, "type") },
    features: features.map((f) => tagName(f) ?? print(f)),
    packageName: plistStr(pkgInfo, "name"),
    prompt: plistStr(pkgInfo, "prompt"),
    /* version: plistStr(plist, "version"), */
    raw: info,
  };
}

/**
 * `(cl:ignore-errors (cl:and (cl:find-symbol …) …))` for one printed frame head,
 * yielding its home package name or nil. `find-symbol` is called three times
 * rather than bound to a variable so the form needs no `let`, whose variable
 * names would themselves be interned into the user's package.
 */
function homePackageForm(head: string, defaultPackage: string): Sexp {
  const colon = head.indexOf(":");
  const pkg = colon > 0 ? head.slice(0, colon) : defaultPackage;
  const name = colon > 0 ? head.slice(colon).replace(/^:+/, "") : head;
  // Upcased for the standard readtable: LispWorks prints `error` but interns ERROR.
  const lookup: Sexp = [sym("cl:find-symbol"), name.toUpperCase(), pkg.toUpperCase()];
  return [
    sym("cl:ignore-errors"),
    [
      sym("cl:and"),
      lookup,
      [sym("cl:symbol-package"), lookup],
      [sym("cl:package-name"), [sym("cl:symbol-package"), lookup]],
    ],
  ];
}
