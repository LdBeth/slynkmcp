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
  let buf = new Uint8Array(0);

  const ensure = async (n: number): Promise<boolean> => {
    while (buf.length < n) {
      const { value, done } = await reader.read();
      if (done) return false;
      const merged = new Uint8Array(buf.length + value.length);
      merged.set(buf, 0);
      merged.set(value, buf.length);
      buf = merged;
    }
    return true;
  };

  try {
    while (true) {
      if (!(await ensure(6))) return;
      const headerStr = decoder.decode(buf.subarray(0, 6));
      const len = Number.parseInt(headerStr, 16);
      if (!Number.isFinite(len) || len < 0) {
        throw new Error(`Invalid frame header: ${JSON.stringify(headerStr)}`);
      }
      if (!(await ensure(6 + len))) {
        throw new Error("Stream ended mid-frame");
      }
      const payload = decoder.decode(buf.subarray(6, 6 + len));
      buf = buf.slice(6 + len);
      yield payload;
    }
  } finally {
    reader.releaseLock();
  }
}
