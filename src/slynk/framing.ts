/**
 * Swank/Slynk wire framing: a 6-character ASCII hex byte-length prefix,
 * followed by a UTF-8 payload of exactly that many bytes.
 *
 *   "000017(:return (:ok nil) 1)"
 *    ^^^^^^                       length = 0x17 = 23 bytes
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeFrame(payload: string): Uint8Array {
  const body = encoder.encode(payload);
  if (body.length > 0xffffff) {
    throw new Error(`Frame too large: ${body.length} bytes (max 16777215)`);
  }
  const hex = body.length.toString(16).padStart(6, "0");
  const out = new Uint8Array(6 + body.length);
  encoder.encodeInto(hex, out);
  out.set(body, 6);
  return out;
}

const HEADER_RE = /^[0-9a-fA-F]{6}$/;

/**
 * Read framed messages from a byte stream. Yields each payload as a string.
 * Buffers partial reads across chunk boundaries.
 */
export async function* readFrames(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = source.getReader();
  // Pending unread chunks. `head` is the byte offset into `chunks[0]` where
  // unread data starts; everything before is logically discarded. Avoids the
  // O(N²) reallocation pattern of growing one flat Uint8Array per chunk.
  const chunks: Uint8Array[] = [];
  let head = 0;
  let total = 0; // total bytes in `chunks`, including the `head` prefix of chunks[0]

  const buffered = () => total - head;

  const fillTo = async (n: number): Promise<boolean> => {
    while (buffered() < n) {
      const { value, done } = await reader.read();
      if (done) return false;
      // Invariant D: never buffer an empty chunk. `take`'s termination depends
      // on every chunk having length > 0 (so `avail > 0` and `written` advances);
      // dropping this guard would let a zero-length read wedge `take` in a spin.
      if (value.length === 0) continue;
      chunks.push(value);
      total += value.length;
    }
    return true;
  };

  // Consume the next `n` bytes as a contiguous Uint8Array. `fillTo(n)` must
  // have returned true.
  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const c = chunks[0]!;
      const avail = c.length - head;
      // `fillTo` guarantees invariant D (no empty chunk, head < c.length), so
      // avail > 0 and the loop makes progress. Assert rather than spin if a
      // future change to the buffering ever breaks that.
      if (avail <= 0) throw new Error("framing: empty chunk in buffer (invariant D violated)");
      const need = n - written;
      if (need < avail) {
        out.set(c.subarray(head, head + need), written);
        head += need;
        return out;
      }
      out.set(c.subarray(head), written);
      written += avail;
      chunks.shift();
      total -= c.length;
      head = 0;
    }
    return out;
  };

  try {
    while (true) {
      if (!(await fillTo(6))) return;
      const headerStr = decoder.decode(take(6));
      if (!HEADER_RE.test(headerStr)) {
        throw new Error(`Invalid frame header: ${JSON.stringify(headerStr)}`);
      }
      // The regex bounds len to [0, 0xffffff], so it can't exceed encodeFrame's cap.
      const len = Number.parseInt(headerStr, 16);
      if (!(await fillTo(len))) {
        throw new Error("Stream ended mid-frame");
      }
      yield decoder.decode(take(len));
    }
  } finally {
    reader.releaseLock();
  }
}
