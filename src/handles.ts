/**
 * Tiny LRU for oversize tool results. The MCP layer truncates large strings
 * and stashes the full text here keyed by a short id; the model can then call
 * `get_handle` to fetch slices.
 */

export interface Handle {
  id: string;
  kind: string;
  data: string;
  createdAt: number;
}

export class HandleStore {
  #map = new Map<string, Handle>();
  #counter = 0;

  constructor(public readonly capacity = 64) {}

  put(kind: string, data: string): Handle {
    const id = `h${(++this.#counter).toString(36)}`;
    const h: Handle = { id, kind, data, createdAt: Date.now() };
    this.#map.set(id, h);
    while (this.#map.size > this.capacity) {
      // Map iteration is insertion-ordered; drop oldest.
      this.#map.delete(this.#map.keys().next().value!);
    }
    return h;
  }

  /**
   * Look up a handle by id, refreshing its LRU recency as a side effect. Note:
   * calling `get` from inside a loop that also iterates `list()` will reorder
   * the underlying map mid-iteration. Read-only inspection paths should snapshot
   * via `list()` first.
   */
  get(id: string): Handle | undefined {
    const h = this.#map.get(id);
    if (h) {
      this.#map.delete(id);
      this.#map.set(id, h);
    }
    return h;
  }

  list(): Handle[] {
    return [...this.#map.values()];
  }
}

/**
 * Slice `text` at `end` UTF-16 code units, backing off by one if the cut would
 * split a surrogate pair. The cap is still in code units (not code points), but
 * the returned string is guaranteed not to contain a lone surrogate.
 */
function safeSlice(text: string, end: number): string {
  if (end <= 0 || end >= text.length) return text.slice(0, end);
  const lastCode = text.charCodeAt(end - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) return text.slice(0, end - 1);
  return text.slice(0, end);
}

/**
 * Wrap a string for tool output: if it exceeds maxChars, truncate and stash
 * the full text in the handle store. Lengths are in UTF-16 code units.
 */
export function maybeTruncate(
  store: HandleStore,
  kind: string,
  text: string,
  maxChars: number,
): { text: string; handleId?: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const h = store.put(kind, text);
  const head = safeSlice(text, maxChars);
  return {
    text: head + `\n…[truncated ${text.length - head.length} chars; full result in handle ${h.id}]`,
    handleId: h.id,
    truncated: true,
  };
}
