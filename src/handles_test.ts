import { assertEquals, assertFalse } from "@std/assert";
import { HandleStore, maybeTruncate } from "./handles.ts";

// ---- HandleStore ----

Deno.test("HandleStore.put - creates handle with auto-incrementing hex id", () => {
  const store = new HandleStore();
  const h1 = store.put("eval", "result 1");
  assertEquals(h1.id, "h1");
  assertEquals(h1.kind, "eval");
  assertEquals(h1.data, "result 1");
  assertEquals(typeof h1.createdAt, "number");

  const h2 = store.put("inspect", "result 2");
  assertEquals(h2.id, "h2");
});

Deno.test("HandleStore.get - retrieves stored handle", () => {
  const store = new HandleStore();
  store.put("eval", "the data");
  const h = store.get("h1");
  assertEquals(h?.data, "the data");
});

Deno.test("HandleStore.get - returns undefined for unknown id", () => {
  const store = new HandleStore();
  assertEquals(store.get("nonexistent"), undefined);
});

Deno.test("HandleStore.get - refreshes recency", () => {
  const store = new HandleStore(3);
  store.put("a", "1"); // h1
  store.put("b", "2"); // h2
  store.put("c", "3"); // h3

  // Access the oldest — it should move to the end.
  store.get("h1");

  // Now h2 is the oldest. Putting a 4th should evict h2, not h1.
  store.put("d", "4");
  assertEquals(store.get("h1")?.kind, "a");
  assertEquals(store.get("h2"), undefined);
  assertEquals(store.get("h3")?.kind, "c");
  assertEquals(store.get("h4")?.kind, "d");
});

Deno.test("HandleStore.list - returns all handles", () => {
  const store = new HandleStore();
  store.put("eval", "a");
  store.put("inspect", "b");
  const items = store.list();
  assertEquals(items.length, 2);
});

Deno.test("HandleStore.list - empty when nothing stored", () => {
  const store = new HandleStore();
  assertEquals(store.list(), []);
});

Deno.test("HandleStore - LRU eviction drops oldest", () => {
  const store = new HandleStore(3);
  store.put("a", "1"); // h1
  store.put("b", "2"); // h2
  store.put("c", "3"); // h3
  store.put("d", "4"); // h4 — should evict h1

  assertEquals(store.get("h1"), undefined);
  assertEquals(store.list().length, 3);
});

// ---- maybeTruncate ----

Deno.test("maybeTruncate - text under maxChars not truncated", () => {
  const store = new HandleStore();
  const r = maybeTruncate(store, "eval", "short", 100);
  assertEquals(r.text, "short");
  assertFalse(r.truncated);
  assertEquals(r.handleId, undefined);
});

Deno.test("maybeTruncate - text exactly at maxChars not truncated", () => {
  const store = new HandleStore();
  const r = maybeTruncate(store, "eval", "12345", 5);
  assertEquals(r.text, "12345");
  assertFalse(r.truncated);
});

Deno.test("maybeTruncate - text over maxChars is truncated and stashed", () => {
  const store = new HandleStore();
  const r = maybeTruncate(store, "eval", "hello world this is long", 5);
  assertEquals(r.text.slice(0, 5), "hello");
  assertEquals(r.truncated, true);
  assertEquals(r.handleId, "h1");
  // Verify full text is in the handle store
  assertEquals(store.get("h1")?.data, "hello world this is long");
});

Deno.test("maybeTruncate - truncation message includes handle id", () => {
  const store = new HandleStore();
  const r = maybeTruncate(store, "eval", "long text here", 4);
  assertEquals(r.handleId, "h1");
  assertEquals(r.text.includes("h1"), true);
  assertEquals(r.text.includes("truncated"), true);
});
