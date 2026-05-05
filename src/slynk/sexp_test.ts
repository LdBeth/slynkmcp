import { assertEquals, assertThrows } from "@std/assert";
import { Cons, Keyword, kw, NIL, print, read, Sym, sym, T } from "./sexp.ts";

Deno.test("read - atoms", () => {
  assertEquals(read("123"), 123);
  assertEquals(read("-5"), -5);
  assertEquals(read("3.14"), 3.14);
  assertEquals(read("nil"), NIL);
  assertEquals(read("NIL"), NIL);
  assertEquals(read("t"), T);
  const k = read(":foo");
  assertEquals((k as Keyword).name, "foo");
  const s = read("car");
  assertEquals((s as Sym).name, "car");
});

Deno.test("read - keywords lowercase", () => {
  const k = read(":OK") as Keyword;
  assertEquals(k.name, "ok");
});

Deno.test("read - strings with escapes", () => {
  assertEquals(read('"hello"'), "hello");
  assertEquals(read('"a\\"b"'), 'a"b');
  assertEquals(read('"a\\\\b"'), "a\\b");
});

Deno.test("read - empty list is nil-equivalent", () => {
  assertEquals(read("()"), []);
});

Deno.test("read - flat list", () => {
  const v = read("(1 2 3)") as number[];
  assertEquals(v, [1, 2, 3]);
});

Deno.test("read - nested list", () => {
  const v = read("(:return (:ok nil) 1)") as unknown[];
  assertEquals((v[0] as Keyword).name, "return");
  const inner = v[1] as unknown[];
  assertEquals((inner[0] as Keyword).name, "ok");
  assertEquals(inner[1], []);
  assertEquals(v[2], 1);
});

Deno.test("read - quote sugar", () => {
  const v = read("'foo") as unknown[];
  assertEquals((v[0] as Sym).name, "quote");
  assertEquals((v[1] as Sym).name, "foo");
});

Deno.test("read - dotted pair", () => {
  const v = read("(a . b)") as Cons;
  assertEquals((v.car as Sym).name, "a");
  assertEquals((v.cdr as Sym).name, "b");
});

Deno.test("read - dotted tail with proper list head", () => {
  // (a b . (c d)) collapses to (a b c d)
  const v = read("(a b . (c d))") as unknown[];
  assertEquals(v.length, 4);
});

Deno.test("read - rejects trailing data", () => {
  assertThrows(() => read("1 2"));
});

Deno.test("print - round-trips simple forms", () => {
  assertEquals(
    print(read('(:emacs-rex (swank:connection-info) "COMMON-LISP-USER" t 1)')),
    '(:emacs-rex (swank:connection-info) "COMMON-LISP-USER" t 1)',
  );
  assertEquals(print(read("(1 2 3)")), "(1 2 3)");
  assertEquals(print(read("nil")), "nil");
});

Deno.test("print - escapes string contents", () => {
  assertEquals(print('he said "hi"'), '"he said \\"hi\\""');
  assertEquals(print("a\\b"), '"a\\\\b"');
});

Deno.test("print - constructed forms", () => {
  const form = [kw("emacs-rex"), [sym("swank:connection-info")], "COMMON-LISP-USER", T, 1];
  assertEquals(print(form), '(:emacs-rex (swank:connection-info) "COMMON-LISP-USER" t 1)');
});

Deno.test("print - dotted pair", () => {
  assertEquals(print(new Cons(sym("a"), sym("b"))), "(a . b)");
});
