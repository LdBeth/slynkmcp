import { assertEquals } from "@std/assert";
import { encodeFrame, readFrames } from "./framing.ts";

const dec = new TextDecoder();
const enc = new TextEncoder();

Deno.test("encodeFrame - simple ascii", () => {
  const f = encodeFrame("(:return (:ok nil) 1)");
  assertEquals(dec.decode(f.subarray(0, 6)), "000015");
  assertEquals(dec.decode(f.subarray(6)), "(:return (:ok nil) 1)");
});

Deno.test("encodeFrame - utf-8 byte length, not char count", () => {
  const f = encodeFrame('"naïve"');
  // n a ï v e → ï is 2 bytes; total = 1+1+2+1+1 + 2 quotes = 8 bytes
  assertEquals(dec.decode(f.subarray(0, 6)), "000008");
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

Deno.test("readFrames - reads multiple frames", async () => {
  const buf = new Uint8Array([
    ...encodeFrame("(:hello)"),
    ...encodeFrame("(:return (:ok 42) 1)"),
  ]);
  const frames: string[] = [];
  for await (const f of readFrames(streamOf(buf))) frames.push(f);
  assertEquals(frames, ["(:hello)", "(:return (:ok 42) 1)"]);
});

Deno.test("readFrames - tolerates split chunks", async () => {
  const full = encodeFrame("(:return (:ok 42) 1)");
  // Split mid-header and mid-body.
  const a = full.subarray(0, 3);
  const b = full.subarray(3, 10);
  const c = full.subarray(10);
  const frames: string[] = [];
  for await (const f of readFrames(streamOf(a, b, c))) frames.push(f);
  assertEquals(frames, ["(:return (:ok 42) 1)"]);
});

Deno.test("readFrames - empty stream yields nothing", async () => {
  const frames: string[] = [];
  for await (const f of readFrames(streamOf())) frames.push(f);
  assertEquals(frames, []);
});

Deno.test("readFrames - utf-8 boundaries handled", async () => {
  const f = encodeFrame('"naïve"');
  const frames: string[] = [];
  for await (const x of readFrames(streamOf(f))) frames.push(x);
  assertEquals(frames, ['"naïve"']);
  // silence unused
  void enc;
});
