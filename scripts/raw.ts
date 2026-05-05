/**
 * Raw protocol test: send one frame, log everything that comes back.
 * Run: deno run --allow-net=localhost:4005 scripts/raw.ts
 */
import { encodeFrame, readFrames } from "../src/slynk/framing.ts";

const conn = await Deno.connect({ hostname: "localhost", port: 4005 });
console.log("connected");

const writer = conn.writable.getWriter();
const msg = '(:emacs-rex (swank:connection-info) "COMMON-LISP-USER" t 1)';
console.log("sending:", msg);
await writer.write(encodeFrame(msg));

const t = setTimeout(() => {
  console.log("--- 5s timeout, closing ---");
  conn.close();
}, 5000);

let i = 0;
for await (const f of readFrames(conn.readable)) {
  console.log(`<<< [${++i}] ${f.slice(0, 500)}${f.length > 500 ? "…" : ""}`);
  if (i >= 3) break;
}
clearTimeout(t);
try {
  conn.close();
} catch { /* */ }
