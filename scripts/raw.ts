/**
 * Raw protocol test: send one frame to Slynk and dump the first few replies.
 * Useful when debugging the framing/sexp layers without going through Session.
 *
 * Run: deno run --allow-net=localhost:4005 scripts/raw.ts
 */

import { encodeFrame, readFrames } from "../src/slynk/framing.ts";

const conn = await Deno.connect({ hostname: "localhost", port: 4005 });
console.error("connected");

const writer = conn.writable.getWriter();
const msg = '(:emacs-rex (slynk:connection-info) "COMMON-LISP-USER" t 1)';
console.error("sending:", msg);
await writer.write(encodeFrame(msg));

const timeout = setTimeout(() => {
  console.error("--- 5s timeout, closing ---");
  conn.close();
}, 5000);

let i = 0;
for await (const frame of readFrames(conn.readable)) {
  console.error(`<<< [${++i}] ${frame.slice(0, 500)}${frame.length > 500 ? "…" : ""}`);
  if (i >= 3) break;
}

clearTimeout(timeout);
try {
  conn.close();
} catch { /* already closed */ }
