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
 * eval's output. The one intentional exception is the auto-abort restart
 * fired from `onDebugActivate` (it bypasses the queue because it must run
 * while the rex it's aborting is still in flight).
 */

import { type RexOptions, SlynkClient } from "./slynk/client.ts";
import { OnceAsync } from "./once_async.ts";
import { type Handle, HandleStore, maybeTruncate } from "./handles.ts";
import { asList, isList, Keyword, print, type Sexp, sym, T, tagName, text } from "./slynk/sexp.ts";
export interface SessionOptions {
  host: string;
  port: number;
  defaultPackage: string;
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
  private mreplChannelId: number | null = null;
  private mreplRemoteId: number | null = null;
  public defaultPackage: string;
  #store = new HandleStore();

  readonly #host: string;
  readonly #port: number;
  readonly #connectGate = new OnceAsync<ConnectionInfo>();
  /** Currently-capturing output buffer (set only during `#evalOnce`). */
  #captureBuf: string[] | null = null;
  /** Mutex queue serializing every Session-level rex call. */
  #queue: Promise<unknown> = Promise.resolve();
  constructor(opts: SessionOptions) {
    this.defaultPackage = opts.defaultPackage;
    this.#host = opts.host;
    this.#port = opts.port;
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
        // Always auto-abort: invoke the first ABORT restart so the rex
        // returns instead of wedging.
        const abortIdx = info.restarts.findIndex((r) => /^abort$/i.test(r.name));
        const idx = abortIdx >= 0 ? abortIdx : info.restarts.length - 1;
        if (idx >= 0) {
          this.#client.rex(
            [sym("slynk:invoke-nth-restart-for-emacs"), info.level, idx],
            { thread: info.thread },
          ).catch(() => {});
        }
      },
      onDisconnect: () => {
        this.mreplChannelId = null;
        this.mreplRemoteId = null;
        this.#connectGate.reset();
        this.#captureBuf = null;
      },
    });
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

      const channelInfo = await this.#client.rex(
        [sym("slynk-mrepl:create-mrepl"), 0],
        { pkg: this.defaultPackage },
      ).catch(() => null);

      if (isList(channelInfo) && channelInfo.length >= 2) {
        this.mreplChannelId = typeof channelInfo[0] === "number" ? channelInfo[0] : null;
        this.mreplRemoteId = typeof channelInfo[1] === "number" ? channelInfo[1] : null;
      }

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
    return this.#runQueued(() => this.#client.rex(form, opts));
  }

  public rex(form: Sexp) {
    return this.#rex(form, { pkg: this.defaultPackage });
  }

  #rexStr(form: Sexp, opts: RexOptions = {}): Promise<string> {
    return this.#rex(form, opts).then(print);
  }

  // `str` coerces nil→"" and :not-available→":not-available"; `print` would
  // render nil as "nil", losing the "nothing to show" signal.
  #rexDisplay(form: Sexp, opts: RexOptions = {}): Promise<string> {
    return this.#rex(form, opts).then(text);
  }

  /**
   * Eval a string in the session's default package, capturing stdout.
   * Errors are auto-aborted from the debugger and surfaced as rejections.
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
    } finally {
      this.#captureBuf = null;
    }
  }

  // -------------------------------------------------------------------
  // Convenience wrappers
  // -------------------------------------------------------------------

  compileFile(path: string, load = true): Promise<string> {
    return this.#rexStr(
      [sym("slynk:compile-file-for-emacs"), path, load ? T : []],
      { pkg: this.defaultPackage },
    );
  }

  loadFile(path: string): Promise<string> {
    return this.#rexStr(
      [sym("slynk:load-file"), path],
      { pkg: this.defaultPackage },
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
      { pkg: this.defaultPackage },
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
      { pkg: this.defaultPackage },
    );
  }

  documentation(symbolName: string): Promise<string> {
    return this.#rexDisplay(
      [sym("slynk:documentation-symbol"), symbolName],
      { pkg: this.defaultPackage },
    );
  }

  arglist(symbolName: string): Promise<string> {
    return this.#rexDisplay(
      [sym("slynk:operator-arglist"), symbolName, this.defaultPackage],
      { pkg: this.defaultPackage },
    );
  }

  macroexpand(form: string, all = false): Promise<string> {
    const op = all ? "slynk:slynk-macroexpand-all" : "slynk:slynk-macroexpand-1";
    return this.#rexDisplay([sym(op), form], { pkg: this.defaultPackage });
  }

  findDefinition(symbolName: string): Promise<string> {
    return this.#rexDisplay(
      [sym("slynk:find-definitions-for-emacs"), symbolName],
      { pkg: this.defaultPackage },
    );
  }

  // ---- Inspector ----

  inspect(expression: string): Promise<string> {
    return this.#rexStr(
      [sym("slynk:init-inspector"), expression],
      { pkg: this.defaultPackage },
    );
  }
  inspectorPart(index: number): Promise<string> {
    return this.#rexStr(
      [sym("slynk:inspect-nth-part"), index],
      { pkg: this.defaultPackage },
    );
  }
  inspectorPop(): Promise<string> {
    return this.#rexStr([sym("slynk:inspector-pop")], {
      pkg: this.defaultPackage,
    });
  }
  inspectorReinspect(): Promise<string> {
    return this.#rexStr([sym("slynk:inspector-reinspect")], {
      pkg: this.defaultPackage,
    });
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

  function plistGet(plist: Sexp[], k: string): Sexp {
    for (let i = 0; i < plist.length - 1; i += 2) {
      const key = plist[i];
      if (key instanceof Keyword && key.name === k) return plist[i + 1];
    }
    return [];
  }

  function plistStr(plist: Sexp[], k: string): string {
    return plistGet(plist, k) as string;
  }

  const lispImpl = asList(plistGet(plist, "lisp-implementation"), "lisp-implementation");
  const machine = asList(plistGet(plist, "machine"), "machine");
  const features = asList(plistGet(plist, "features"), "features");
  const pkgInfo = asList(plistGet(plist, "package"), "package");
  const pid = plistGet(plist, "pid");

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
