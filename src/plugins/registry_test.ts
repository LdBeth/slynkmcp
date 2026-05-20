import { assert, assertEquals, assertThrows } from "@std/assert";
import { loadPlugins, PLUGINS } from "./registry.ts";
import type { Plugin } from "./types.ts";

const fakeA: Plugin = { name: "a", instructions: "no", register: () => {} };
const fakeB: Plugin = { name: "b", instructions: "no", register: () => {} };
const TEST_REGISTRY: Record<string, Plugin> = { a: fakeA, b: fakeB };

Deno.test("loadPlugins - resolves names in given order", () => {
  const result = loadPlugins(["a", "b"], TEST_REGISTRY);
  assertEquals(result.map((p) => p.name), ["a", "b"]);
});

Deno.test("loadPlugins - empty input yields empty output", () => {
  assertEquals(loadPlugins([], TEST_REGISTRY), []);
});

Deno.test("loadPlugins - de-duplicates repeated names", () => {
  const result = loadPlugins(["a", "a", "b", "a"], TEST_REGISTRY);
  assertEquals(result.map((p) => p.name), ["a", "b"]);
});

Deno.test("loadPlugins - throws on unknown name with known names listed", () => {
  const e = assertThrows(
    () => loadPlugins(["nope"], TEST_REGISTRY),
    Error,
  );
  const msg = (e as Error).message;
  if (!msg.includes("nope") || !msg.includes("a")) {
    throw new Error(`message did not include both bad and known names: ${msg}`);
  }
});

Deno.test("loadPlugins - default registry has the in-tree plugins", () => {
  assert("opusmodus" in PLUGINS, "opusmodus plugin should be registered by default");
  assert("inspector" in PLUGINS, "inspector plugin should be registered by default");
});

Deno.test("loadPlugins - empty input against default registry yields empty output", () => {
  assertEquals(loadPlugins([]), []);
});
