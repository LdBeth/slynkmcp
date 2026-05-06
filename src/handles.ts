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

  get(id: string): Handle | undefined {
    const h = this.#map.get(id);
    if (h) {
      // Refresh recency: re-insert.
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
 * Wrap a string for tool output: if it exceeds maxChars, truncate and stash
 * the full text in the handle store.
 */
export function maybeTruncate(
  store: HandleStore,
  kind: string,
  text: string,
  maxChars: number,
): { text: string; handleId?: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const h = store.put(kind, text);
  const head = text.slice(0, maxChars);
  return {
    text: head + `\n…[truncated ${text.length - maxChars} chars; full result in handle ${h.id}]`,
    handleId: h.id,
    truncated: true,
  };
}
