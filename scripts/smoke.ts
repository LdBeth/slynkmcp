/**
 * Smoke test: connect to a running Slynk and exercise the Session API.
 * Logs to stderr (unbuffered).
 */

import { Session } from "../src/session.ts";
import { print, read } from "../src/slynk/sexp.ts";

const log = (...a: unknown[]) => console.error(...a);

const session = new Session({
  host: "localhost",
  port: 4005,
  defaultPackage: "om",
});

// Hook unknown events for visibility.
session.client.events.onUnknown = (e) => log("[unknown]", print(e).slice(0, 200));
session.client.events.onDisconnect = (e) => log("[disconnect]", e?.message);

log("connecting…");
await session.ensureConnected();
log("connected");

const ci = await session.getConnectionInfo();
if (!ci) {
  log("no connection-info parsed");
  Deno.exit(1);
}
log(`pid=${ci.pid} lisp=${ci.lispImplementation.name} ${ci.lispImplementation.version}`);
log(`package=${ci.packageName} prompt=${ci.prompt}`);
// deno-lint-ignore no-explicit-any
log(`mREPL channel=${(session as any).mreplChannelId} remote=${(session as any).mreplRemoteId}`);

log("\n--- (+ 1 2) ---");
log(await session.eval("(+ 1 2)"));

log("\n--- arglist mapcar ---");
log(await session.arglist("mapcar"));

log("\n--- apropos 'omn' (external only) ---");
log((await session.apropos("omn")).slice(0, 600));

log("\n--- arglist of an OM symbol: length-rest ---");
log(await session.arglist("length-rest"));

log('\n--- captured stdout: (progn (princ "hello ") (princ-to-string \'(1 2 3))) ---');
log(await session.eval('(progn (princ "hello ") (princ-to-string \'(1 2 3)))'));

log("\n--- find OPUSMODUS package + a real OM function ---");
log((await session.eval("(find-package :opusmodus)")).value);
log(
  (await session.eval(
    "(do-symbols (s :opusmodus) (when (and (fboundp s) (eq (symbol-package s) (find-package :opusmodus))) (return s)))",
  )).value,
);

log("\n--- macroexpand-1 (defun foo () 1) ---");
log((await session.macroexpand("(defun foo () 1)", false)).slice(0, 300));

log('\n--- triggering debugger: (error "boom") ---');
try {
  log(await session.eval('(error "boom")'));
} catch (e) {
  log("eval threw:", (e as Error).message);
}
log("currentDebug after auto-abort:", session.currentDebug());

await session.stop();
log("done");

void read; // silence unused
