/**
 * High-level session: owns the SlynkClient, bootstraps the connection,
 * creates an mREPL channel, captures per-request output, and exposes a
 * convenient API for MCP tools.
 *
 * Output capture: Slynk's `:write-string` and channel-send messages arrive
 * asynchronously, not tied to a request id, so we can't perfectly attribute
 * them. The pragmatic approach used here: serialize tool calls that need
 * output capture, and accumulate everything between rex-send and rex-resolve
 * into a single buffer.
 */

import { type RexOptions, SlynkClient } from "./slynk/client.ts";
import { OnceAsync } from "./once_async.ts";
import { type Handle, HandleStore, maybeTruncate } from "./handles.ts";
import { asList, Keyword, print, type Sexp, str, Sym, sym, T, tagName } from "./slynk/sexp.ts";

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
  version: string;
  raw: Sexp;
}

export interface EvalResult {
  /** Printed result (the value Lisp returned, as a string). */
  value: string;
  /** Captured stdout / mREPL output during the call. */
  output: string;
  /** True when the evaluation suspended in the debugger instead of returning. */
  debugEntered?: boolean;
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
  /** Currently-capturing output buffer (set while a tool call is in flight). */
  #captureBuf: string[] | null = null;
  /** Mutex queue for output-capturing calls. */
  #queue: Promise<unknown> = Promise.resolve();
  /** A parked interactive eval whose rex is suspended in the debugger. */
  #suspendedEval: { rexPromise: Promise<Sexp>; buf: string[] } | null = null;
  /** Set while eval / a resume is waiting for an interactive debugger to open. */
  #debugEntered: Deferred | null = null;

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
        if (!Array.isArray(msg) || msg.length === 0) return;
        const tag = tagName(msg[0]);
        if (!tag) return;
        if (tag === "write-string" && typeof msg[1] === "string") {
          if (this.#captureBuf) this.#captureBuf.push(msg[1]);
        }
        // Other channel messages (:prompt, :evaluation-aborted) are diagnostic;
        // we surface eval status via the rex return value, not the channel.
      },
      onDebugActivate: (info) => {
        if (info.interactive) {
          // lisp_eval's debugger: leave it open for the model to drive;
          // just wake whoever is waiting for the suspend signal.
          this.#debugEntered?.fire();
          return;
        }
        // Auto-abort policy for every non-interactive tool: invoke the first
        // ABORT-ish restart so the rex returns instead of wedging.
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
        // Drop cached per-connection state; next tool call rebuilds via ensureConnected().
        this.mreplChannelId = null;
        this.mreplRemoteId = null;
        this.#connectGate.reset();
        this.#suspendedEval = null;
        this.#captureBuf = null;
        this.#debugEntered = null;
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

    if (Array.isArray(channelInfo) && channelInfo.length >= 2) {
      this.mreplChannelId = typeof channelInfo[0] === "number" ? channelInfo[0] : null;
      this.mreplRemoteId = typeof channelInfo[1] === "number" ? channelInfo[1] : null;
    }

    return parsed;
  }

  async stop(): Promise<void> {
    await this.#client.close();
  }

  /** Connect (if needed) then dispatch an rex. */
  async #rex(form: Sexp, opts: RexOptions = {}): Promise<Sexp> {
    await this.#ensureConnected();
    return this.#client.rex(form, opts);
  }

  public rex(form: Sexp) {
    return this.#rex(form, { pkg: this.defaultPackage });
  }

  #rexStr(form: Sexp, opts: RexOptions = {}): Promise<string> {
    return this.#rex(form, opts).then(print);
  }

  /**
   * Eval a string in the session's default package, capturing stdout.
   *
   * If the evaluation drops into the Slynk debugger, this resolves early with
   * `debugEntered: true` and parks the rex; the `lisp_debug_*` tools then drive
   * it. Calls are serialized so capture buffers never interleave.
   */
  async eval(code: string, pkg?: string): Promise<EvalResult> {
    await this.#ensureConnected();
    const p = pkg ?? this.defaultPackage;
    const run = () => this.#evalOnce(code, p);
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #evalOnce(code: string, pkg: string): Promise<EvalResult> {
    if (this.#suspendedEval) {
      const lvl = this.currentDebug()?.level ?? "?";
      throw new Error(
        `a previous evaluation is suspended in the debugger at level ${lvl} — ` +
          `resolve it with the lisp_debug_* tools first`,
      );
    }
    const buf: string[] = [];
    this.#captureBuf = buf;
    const rexPromise = this.#client.rex(
      [sym("slynk:interactive-eval"), code],
      { pkg, interactive: true },
    );
    rexPromise.catch(() => {}); // a parked rex may reject later via abort
    const entered = deferred();
    this.#debugEntered = entered;
    try {
      const winner = await Promise.race([
        rexPromise.then((v) => ({ debug: false as const, value: v as string })),
        entered.promise.then(() => ({ debug: true as const, value: "" })),
      ]);
      if (!winner.debug) {
        this.#captureBuf = null;
        return { value: winner.value, output: buf.join("") };
      }
      // Suspended: keep #captureBuf installed so post-resume output is captured.
      this.#suspendedEval = { rexPromise, buf };
      return { value: "", output: buf.join(""), debugEntered: true };
    } finally {
      this.#debugEntered = null;
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
    if (!Array.isArray(result) || !Array.isArray(result[0])) return [];
    return (result[0] as Sexp[]).filter((x): x is string => typeof x === "string");
  }

  apropos(pattern: string, externalOnly = true): Promise<string> {
    return this.#rexStr(
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

  describe(symbolName: string): Promise<string> {
    return this.#rex(
      [sym("slynk:describe-symbol"), symbolName],
      { pkg: this.defaultPackage },
    ) as Promise<string>;
  }

  documentation(symbolName: string): Promise<string> {
    return this.#rex(
      [sym("slynk:documentation-symbol"), symbolName],
      { pkg: this.defaultPackage },
    ) as Promise<string>;
  }

  arglist(symbolName: string): Promise<string> {
    return this.#rex(
      [sym("slynk:operator-arglist"), symbolName, this.defaultPackage],
      { pkg: this.defaultPackage },
    ) as Promise<string>;
  }

  macroexpand(form: string, all = false): Promise<string> {
    const op = all ? "slynk:slynk-macroexpand-all" : "slynk:slynk-macroexpand-1";
    return this.#rex([sym(op), form], { pkg: this.defaultPackage }) as Promise<string>;
  }

  findDefinition(symbolName: string): Promise<string> {
    return this.#rex(
      [sym("slynk:find-definitions-for-emacs"), symbolName],
      { pkg: this.defaultPackage },
    ) as Promise<string>;
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

  // ---- Debugger ----

  currentDebug() {
    return this.#client.debugStack[this.#client.debugStack.length - 1] ?? null;
  }

  debugInvokeRestart(restartIndex: number): Promise<string> {
    const top = this.currentDebug();
    if (!top) throw new Error("Not in debugger");
    return this.#resumeVia(
      [sym("slynk:invoke-nth-restart-for-emacs"), top.level, restartIndex],
      { thread: top.thread },
    );
  }

  debugAbort(): Promise<string> {
    const top = this.currentDebug();
    if (!top) throw new Error("Not in debugger");
    return this.#resumeVia([sym("slynk:throw-to-toplevel")], { thread: top.thread });
  }

  /**
   * Send a restart / throw-to-toplevel form, then report the outcome of the
   * suspended eval: its value+output if it ran to completion, an aborted
   * notice if it unwound, or a re-entered-debugger notice if it errored again.
   */
  async #resumeVia(form: Sexp, opts: RexOptions): Promise<string> {
    const susp = this.#suspendedEval;
    const ack = this.#client.rex(form, opts);
    ack.catch(() => {});
    if (!susp) return print(await ack);

    const entered = deferred();
    this.#debugEntered = entered;
    let outcome:
      | { kind: "value"; value: string }
      | { kind: "abort"; message: string }
      | { kind: "redebug" };
    try {
      outcome = await Promise.race([
        susp.rexPromise.then(
          (v) => ({ kind: "value" as const, value: v as string }),
          (e) => ({ kind: "abort" as const, message: (e as Error).message }),
        ),
        entered.promise.then(() => ({ kind: "redebug" as const })),
      ]);
    } finally {
      this.#debugEntered = null;
    }

    if (outcome.kind === "redebug") {
      // Still suspended at a fresh level; defAsyncTool's debugSummary shows it.
      return "evaluation re-entered the debugger";
    }
    const output = susp.buf.join("");
    this.#suspendedEval = null;
    this.#captureBuf = null;
    if (outcome.kind === "value") {
      return (output ? `[stdout]\n${output}\n[value]\n` : "") + outcome.value;
    }
    return (output ? `[stdout]\n${output}\n` : "") +
      `evaluation aborted: ${outcome.message}`;
  }

  debugFrameLocals(frameIndex: number): Promise<string> {
    const top = this.currentDebug();
    if (!top) throw new Error("Not in debugger");
    return this.#rexStr(
      [sym("slynk:frame-locals-and-catch-tags"), frameIndex],
      { thread: top.thread },
    );
  }

  debugFrameSource(frameIndex: number): Promise<string> {
    const top = this.currentDebug();
    if (!top) throw new Error("Not in debugger");
    return this.#rexStr(
      [sym("slynk:frame-source-location"), frameIndex],
      { thread: top.thread },
    );
  }

  debugEvalInFrame(frameIndex: number, code: string): Promise<string> {
    const top = this.currentDebug();
    if (!top) throw new Error("Not in debugger");
    return this.#rexStr(
      [sym("slynk:eval-string-in-frame"), code, frameIndex, this.defaultPackage],
      { thread: top.thread },
    );
  }

  /** Send :emacs-interrupt. No-op if not currently connected. */
  interrupt(): void {
    if (!this.#client.isConnected) return;
    this.#client.interrupt(":repl-thread");
  }
}

function parseConnectionInfo(info: Sexp): ConnectionInfo {
  // Slynk returns a property list: (:pid N :lisp-implementation (...) ...)
  const plist = asList(info, "connection-info");

  function plistGet(k: string): Sexp {
    for (let i = 0; i < plist.length - 1; i += 2) {
      const key = plist[i];
      if (key instanceof Keyword && key.name === k) return plist[i + 1];
    }
    return [];
  }

  function plistStr(subplist: Sexp[], k: string): string {
    for (let i = 0; i < subplist.length - 1; i += 2) {
      const key = subplist[i];
      if (key instanceof Keyword && key.name === k) return str(subplist[i + 1] ?? []);
    }
    return "";
  }

  const lispImpl = asList(plistGet("lisp-implementation"), "lisp-implementation");
  const machine = asList(plistGet("machine"), "machine");
  const features = asList(plistGet("features"), "features");
  const pkgInfo = asList(plistGet("package"), "package");
  const pid = plistGet("pid");

  return {
    pid: typeof pid === "number" ? pid : 0,
    lisp: {
      type: plistStr(lispImpl, "type"),
      name: plistStr(lispImpl, "name"),
      version: plistStr(lispImpl, "version"),
    },
    machine: { instance: plistStr(machine, "instance"), type: plistStr(machine, "type") },
    features: features.map((f) => f instanceof Sym ? f.name : (f as Keyword)?.name ?? print(f)),
    packageName: plistStr(pkgInfo, "name"),
    prompt: plistStr(pkgInfo, "prompt"),
    version: str(plistGet("version") ?? [], ""),
    raw: info,
  };
}

interface Deferred {
  promise: Promise<void>;
  fire: () => void;
}

/** A one-shot promise whose resolution is triggered externally. */
function deferred(): Deferred {
  let fire!: () => void;
  const promise = new Promise<void>((res) => {
    fire = res;
  });
  return { promise, fire };
}
