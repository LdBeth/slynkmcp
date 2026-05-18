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
  // Header is always 6 ASCII hex chars — write directly, no intermediate encode.
  for (let i = 0; i < 6; i++) out[i] = hex.charCodeAt(i);
  out.set(body, 6);
  return out;
}

/**
 * Read framed messages from a byte stream. Yields each payload as a string.
 * Buffers partial reads across chunk boundaries.
 */
export async function* readFrames(
  source: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = source.getReader();
  let chunks: Uint8Array[] = [];
  let totalLen = 0;

  const ensure = async (n: number): Promise<boolean> => {
    while (totalLen < n) {
      const { value, done } = await reader.read();
      if (done) return false;
      chunks.push(value);
      totalLen += value.length;
    }
    return true;
  };

  const flatten = (): Uint8Array => {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(totalLen);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  };

  try {
    while (true) {
      if (!(await ensure(6))) return;
      const flat = flatten();
      chunks = [flat];
      totalLen = flat.length;
      const headerStr = decoder.decode(flat.subarray(0, 6));
      const len = Number.parseInt(headerStr, 16);
      if (!Number.isFinite(len) || len < 0) {
        throw new Error(`Invalid frame header: ${JSON.stringify(headerStr)}`);
      }
      if (!(await ensure(6 + len))) {
        throw new Error("Stream ended mid-frame");
      }
      // flatten() short-circuits when chunks.length === 1, so this is a no-op
      // unless ensure() read more data above.
      const full = flatten();
      const payload = decoder.decode(full.subarray(6, 6 + len));
      const remaining = full.slice(6 + len);
      chunks = remaining.length > 0 ? [remaining] : [];
      totalLen = remaining.length;
      yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}
