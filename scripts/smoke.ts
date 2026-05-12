/**
 * Smoke test: exercise the public Session API against a running Slynk on
 * localhost:4005. Logs to stderr.
 *
 * Run: deno run --allow-net=localhost:4005 scripts/smoke.ts
 */

import { Session } from "../src/session.ts";

const log = (...a: unknown[]) => console.error(...a);

const session = new Session({
  host: "localhost",
  port: 4005,
  defaultPackage: "cl-user",
});

log("connecting…");
await session.ensureConnected();
log("connected");

const ci = await session.getConnectionInfo();
log(`pid=${ci.pid} lisp=${ci.lispImplementation.name} ${ci.lispImplementation.version}`);
log(`package=${ci.packageName} prompt=${ci.prompt}`);
log(`mREPL channel=${session.mreplChannelId} remote=${session.mreplRemoteId}`);

log("\n--- (+ 1 2) ---");
log(await session.eval("(+ 1 2)"));

log("\n--- arglist mapcar ---");
log(await session.arglist("mapcar"));

log("\n--- completions 'map ---");
log((await session.completions("map")).slice(0, 20).join(" "));

log("\n--- apropos 'list' (external only, truncated) ---");
log((await session.apropos("list")).slice(0, 400));

log('\n--- captured stdout: (progn (princ "hello ") (+ 1 2)) ---');
log(await session.eval('(progn (princ "hello ") (+ 1 2))'));

log("\n--- macroexpand-1 (defun foo () 1) ---");
log((await session.macroexpand("(defun foo () 1)", false)).slice(0, 300));

log('\n--- triggering debugger: (error "boom") ---');
try {
  log(await session.eval('(error "boom")'));
} catch (e) {
  log("eval threw:", (e as Error).message);
}
log("currentDebug after auto-abort:", session.currentDebug());

log("\n--- handle truncation roundtrip ---");
const big = "x".repeat(50);
const out = session.truncate("test", big, 10);
log("truncated:", out);
const handles = session.listHandles();
log("handles:", handles.map((h) => `${h.id}/${h.kind}/${h.data.length}b`).join(" "));
if (handles.length > 0) {
  const h = session.getHandle(handles[0].id);
  log("fetched:", h?.data.length, "chars");
}

await session.stop();
log("done");
