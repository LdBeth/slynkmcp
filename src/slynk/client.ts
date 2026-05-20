/**
 * Slynk client. Maintains a single TCP connection, dispatches incoming events
 * to per-request continuations and to side-channel handlers.
 *
 * RPC model: every `rex` call generates a fresh request id, sends an
 * `(:emacs-rex FORM PACKAGE THREAD ID)` frame, and resolves when the matching
 * `(:return (:ok ...) ID)` frame arrives. `(:return (:abort REASON) ID)`
 * rejects the promise. Debugger entries are always auto-aborted via the
 * `onDebugActivate` callback.
 */

import { encodeFrame, readFrames } from "./framing.ts";
import {
  asList,
  asNumber,
  isKw,
  Keyword,
  kw,
  print,
  read,
  type Sexp,
  sym,
  T,
  tagName,
} from "./sexp.ts";

export type DebugInfo = {
  thread: number;
  level: number;
  condition: { message: string; type: string };
  restarts: { name: string; description: string }[];
  frames: { index: number; description: string }[];
};

export interface SlynkEvents {
  onWriteString?: (text: string, target: Sexp) => void;
  onChannelSend?: (channelId: number, message: Sexp) => void;
  onDebugActivate?: (info: DebugInfo) => void;
  onDebugReturn?: (thread: number, level: number) => void;
  onNewFeatures?: (features: Sexp) => void;
  onIndentationUpdate?: (updates: Sexp) => void;
  onDisconnect?: (err?: Error) => void;
  /** Anything we don't recognize — useful for logging */
  onUnknown?: (event: Sexp) => void;
}

interface Pending {
  resolve: (value: Sexp) => void;
  reject: (err: Error) => void;
}

export interface RexOptions {
  /** Common Lisp package name; defaults to "COMMON-LISP-USER" */
  pkg?: string;
  /** Slynk thread designator; "t" (default), ":repl-thread", or a number */
  thread?: "t" | ":repl-thread" | number;
}

function threadSexp(thread?: "t" | ":repl-thread" | number): Sexp {
  if (thread === undefined || thread === "t") return T;
  if (typeof thread === "number") return thread;
  return new Keyword(thread.replace(/^:/, ""));
}

export class SlynkClient {
  #conn: Deno.TcpConn | null = null;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #readerTask: Promise<void> | null = null;

  /** Stack of active debug levels (innermost last). */
  debugStack: DebugInfo[] = [];

  constructor(public readonly events: SlynkEvents = {}) {}

  get isConnected(): boolean {
    return this.#writer !== null;
  }

  async connect(host: string, port: number): Promise<void> {
    this.#conn = await Deno.connect({ hostname: host, port, transport: "tcp" });
    this.#writer = this.#conn.writable.getWriter();
    const stream = this.#conn.readable;
    const teardown = (maybeErr?: Error) => {
      try {
        this.#writer?.releaseLock();
      } catch { /* noop */ }
      this.#writer = null;
      this.#conn = null;
      this.#readerTask = null;
      // Fires once per connection lifetime, on both clean close and read errors.
      this.events.onDisconnect?.(maybeErr);
    };

    this.#readerTask = this.#readLoop(stream).then(
      () => teardown(),
      (err) => teardown(err instanceof Error ? err : new Error(String(err))),
    );
  }

  async close(): Promise<void> {
    try {
      this.#conn?.close();
    } catch { /* noop */ }
    if (this.#readerTask) await this.#readerTask.catch(() => {});
  }

  /** Send `(:emacs-rex FORM PKG THREAD ID)` and await the matching :return. */
  rex(form: Sexp, opts: RexOptions = {}): Promise<Sexp> {
    if (!this.#writer) throw new Error("Not connected");
    const id = this.#nextId++;
    const pkg = opts.pkg ?? "COMMON-LISP-USER";
    const message: Sexp = [kw("emacs-rex"), form, pkg, threadSexp(opts.thread), id];
    const promise = new Promise<Sexp>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    let writeP: Promise<void>;
    try {
      writeP = this.#send(print(message));
    } catch (e) {
      this.#pending.delete(id);
      throw e;
    }
    writeP.catch((err) => {
      const p = this.#pending.get(id);
      if (!p) return;
      this.#pending.delete(id);
      p.reject(err instanceof Error ? err : new Error(String(err)));
    });
    return promise;
  }

  /** Send a raw `:emacs-interrupt` for the given thread (or :repl-thread). */
  interrupt(thread: "t" | ":repl-thread" | number = ":repl-thread"): void {
    this.#fireAndForget(print([kw("emacs-interrupt"), threadSexp(thread)]), "interrupt");
  }

  /** Send a raw channel message. */
  channelSend(channelId: number, message: Sexp): void {
    this.#fireAndForget(
      print([kw("emacs-channel-send"), channelId, message]),
      "channelSend",
    );
  }

  // ---- internals ----

  #send(payload: string): Promise<void> {
    if (!this.#writer) throw new Error("Not connected");
    return this.#writer.write(encodeFrame(payload));
  }

  #fireAndForget(payload: string, label: string): void {
    try {
      this.#send(payload).catch((err) => {
        console.error(`Slynk: ${label} write failed:`, err);
      });
    } catch (err) {
      console.error(`Slynk: ${label} send failed:`, err);
    }
  }

  async #readLoop(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const frame of readFrames(stream)) {
      let parsed: Sexp;
      try {
        parsed = read(frame);
      } catch (err) {
        console.error("Slynk: failed to parse frame:", frame, err);
        continue;
      }
      try {
        this.#dispatch(parsed);
      } catch (err) {
        console.error("Slynk: dispatch failed for event:", print(parsed), err);
      }
    }
    // Stream ended — fail any pending requests and drop per-connection state.
    for (const [, p] of this.#pending) {
      p.reject(new Error("Slynk connection closed"));
    }
    this.#pending.clear();
    this.debugStack.length = 0;
  }

  #dispatch(event: Sexp): void {
    if (!Array.isArray(event) || event.length === 0) {
      this.events.onUnknown?.(event);
      return;
    }
    const tag = tagName(event[0]);
    if (!tag) {
      this.events.onUnknown?.(event);
      return;
    }

    switch (tag) {
      case "return": {
        // (:return (:ok VALUE) ID)  or  (:return (:abort REASON) ID)
        const result = Array.isArray(event[1]) ? event[1] : null;
        const id = typeof event[2] === "number" ? event[2] : null;
        if (!result || id === null) return;
        const p = this.#pending.get(id);
        if (!p) return;
        this.#pending.delete(id);
        const status = result[0];
        if (isKw(status, "ok")) {
          p.resolve(result[1] ?? []);
        } else if (isKw(status, "abort")) {
          const reason = result[1];
          p.reject(
            new Error(`Slynk abort: ${typeof reason === "string" ? reason : print(reason ?? [])}`),
          );
        } else {
          p.reject(new Error(`Unknown :return status: ${print(result)}`));
        }
        return;
      }

      case "debug": {
        // (:debug THREAD LEVEL CONDITION RESTARTS FRAMES PENDING-IDS)
        const thread = asNumber(event[1]!, ":debug thread");
        const level = asNumber(event[2]!, ":debug level");
        const condList = asList(event[3]!, ":debug condition");
        const restartList = asList(event[4]!, ":debug restarts");
        const frameList = asList(event[5]!, ":debug frames");

        const info: DebugInfo = {
          thread,
          level,
          condition: {
            message: typeof condList[0] === "string" ? condList[0] : print(condList[0] ?? []),
            type: typeof condList[1] === "string" ? condList[1] : print(condList[1] ?? []),
          },
          restarts: restartList.map((r) => {
            const rl = asList(r, "restart");
            return {
              name: typeof rl[0] === "string" ? rl[0] : print(rl[0] ?? []),
              description: typeof rl[1] === "string" ? rl[1] : print(rl[1] ?? []),
            };
          }),
          frames: frameList.map((f) => {
            const fl = asList(f, "frame");
            return {
              index: typeof fl[0] === "number" ? fl[0] : 0,
              description: typeof fl[1] === "string" ? fl[1] : print(fl[1] ?? []),
            };
          }),
        };
        this.debugStack.push(info);
        return;
      }

      case "debug-activate": {
        // (:debug-activate THREAD LEVEL [SELECT])
        const top = this.debugStack[this.debugStack.length - 1];
        if (top) this.events.onDebugActivate?.(top);
        return;
      }

      case "debug-return": {
        // (:debug-return THREAD LEVEL STEPPING)
        const thread = asNumber(event[1]!, ":debug-return thread");
        const level = asNumber(event[2]!, ":debug-return level");
        // Pop the matching level (and anything above, defensively).
        while (
          this.debugStack.length && this.debugStack[this.debugStack.length - 1]!.level >= level
        ) {
          this.debugStack.pop();
        }
        this.events.onDebugReturn?.(thread, level);
        return;
      }

      case "write-string": {
        // (:write-string TEXT [TARGET])
        const text = typeof event[1] === "string" ? event[1] : "";
        this.events.onWriteString?.(text, event[2] ?? []);
        return;
      }

      case "channel-send": {
        // (:channel-send CHANNEL-ID MESSAGE)
        const cid = asNumber(event[1]!, ":channel-send id");
        this.events.onChannelSend?.(cid, event[2] ?? []);
        return;
      }

      case "new-features":
        this.events.onNewFeatures?.(event[1] ?? []);
        return;

      case "indentation-update":
        this.events.onIndentationUpdate?.(event[1] ?? []);
        return;

      case "reader-error": {
        // (:reader-error PACKET CONDITION) — Slynk failed to parse our last
        // request. There's no id in the event, so fail the most recent pending
        // rex (highest id) — that's the one that just went out the wire.
        //
        // Invariant: this is only sound when at most one rex is awaiting parse
        // at any moment. Session enforces that by serializing every rex through
        // `#queue` (see session.ts `#runQueued`). If a future change ever lets
        // rexes overlap, this recovery picks the wrong victim — re-examine
        // before pipelining.
        const reason = typeof event[2] === "string" ? event[2] : print(event[2] ?? []);
        let maxId = -1;
        for (const id of this.#pending.keys()) if (id > maxId) maxId = id;
        if (maxId >= 0) {
          const p = this.#pending.get(maxId)!;
          this.#pending.delete(maxId);
          p.reject(new Error(`Slynk reader-error: ${reason}`));
        }
        return;
      }

      case "ping": {
        // (:ping THREAD TAG) — must echo (:emacs-pong THREAD TAG)
        const t = event[1] ?? T;
        const tag = event[2] ?? 0;
        this.#fireAndForget(print([kw("emacs-pong"), t, tag]), "pong");
        return;
      }

      case "read-string":
      case "read-from-minibuffer":
      case "y-or-n-p":
      case "eval-no-wait":
      case "background-message":
      case "inspect":
      case "presentation-start":
      case "presentation-end":
        // Not used by the MCP bridge; ignore quietly.
        return;

      default:
        this.events.onUnknown?.(event);
        return;
    }
  }
}

// Re-exports for convenience.
export { kw, print, read, type Sexp, sym };
