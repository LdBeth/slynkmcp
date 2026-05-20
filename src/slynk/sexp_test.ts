import { assertEquals, assertThrows } from "@std/assert";
import {
  asList,
  asNumber,
  asString,
  Cons,
  isKw,
  isSym,
  Keyword,
  kw,
  Lit,
  NIL,
  print,
  read,
  str,
  Sym,
  sym,
  T,
  tagName,
} from "./sexp.ts";

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

Deno.test("read - #<...> preserved as Lit and round-trips", () => {
  const v = read("#<FUNCTION FOO>");
  assertEquals(v instanceof Lit, true);
  assertEquals((v as Lit).content, "#<FUNCTION FOO>");
  assertEquals(print(v), "#<FUNCTION FOO>");
});

Deno.test("read - #<...> inside a list", () => {
  const v = read("(:value #<HASH-TABLE :TEST EQL> 0)") as unknown[];
  assertEquals((v[0] as Keyword).name, "value");
  assertEquals(v[1] instanceof Lit, true);
  assertEquals((v[1] as Lit).content, "#<HASH-TABLE :TEST EQL>");
  assertEquals(v[2], 0);
});

Deno.test("read - #\\Space character literal", () => {
  const v = read("#\\Space");
  assertEquals(v instanceof Lit, true);
  assertEquals((v as Lit).content, "#\\Space");
});

Deno.test("read - #\\a single-char literal", () => {
  const v = read("#\\a");
  assertEquals((v as Lit).content, "#\\a");
});

Deno.test("read - unterminated #< throws", () => {
  assertThrows(() => read("#<oops"));
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

// ---- str() ----

Deno.test("str - string passes through", () => {
  assertEquals(str("hello"), "hello");
});

Deno.test("str - number to string", () => {
  assertEquals(str(42), "42");
  assertEquals(str(-3.14), "-3.14");
});

Deno.test("str - Sym returns name", () => {
  assertEquals(str(sym("car")), "car");
});

Deno.test("str - T as Sym", () => {
  assertEquals(str(T), "t");
});

Deno.test("str - Keyword returns :name", () => {
  assertEquals(str(kw("foo")), ":foo");
});

Deno.test("str - nil uses fallback", () => {
  assertEquals(str(NIL), "");
  assertEquals(str(NIL, "n/a"), "n/a");
});

Deno.test("str - Cons prints as dotted pair", () => {
  assertEquals(str(new Cons(sym("a"), sym("b"))), "(a . b)");
});

// ---- tagName() ----

Deno.test("tagName - Sym returns name", () => {
  assertEquals(tagName(sym("car")), "car");
});

Deno.test("tagName - Keyword returns name", () => {
  assertEquals(tagName(kw("foo")), "foo");
});

Deno.test("tagName - string returns undefined", () => {
  assertEquals(tagName("hello"), undefined);
});

Deno.test("tagName - number returns undefined", () => {
  assertEquals(tagName(42), undefined);
});

Deno.test("tagName - list returns undefined", () => {
  assertEquals(tagName([sym("a")]), undefined);
});

// ---- isSym / isKw with name ----

Deno.test("isSym - without name matches any Sym", () => {
  assertEquals(isSym(sym("car")), true);
  assertEquals(isSym("not-a-sym"), false);
});

Deno.test("isSym - case-insensitive name match", () => {
  assertEquals(isSym(sym("car"), "CAR"), true);
  assertEquals(isSym(sym("car"), "Car"), true);
  assertEquals(isSym(sym("car"), "cdr"), false);
});

Deno.test("isSym - list is not Sym even with matching name", () => {
  assertEquals(isSym([], "nil"), false);
});

Deno.test("isKw - without name matches any Keyword", () => {
  assertEquals(isKw(kw("foo")), true);
  assertEquals(isKw(sym("foo")), false);
});

Deno.test("isKw - case-insensitive name match", () => {
  assertEquals(isKw(kw("foo"), "FOO"), true);
  assertEquals(isKw(kw("foo"), "Foo"), true);
  assertEquals(isKw(kw("foo"), "bar"), false);
});

// ---- asList / asString / asNumber error paths ----

Deno.test("asList - throws on non-list", () => {
  assertThrows(() => asList("not-a-list"));
  assertThrows(() => asList(42));
});

Deno.test("asList - returns list unchanged", () => {
  const v = [sym("a")];
  assertEquals(asList(v), v);
});

Deno.test("asString - throws on non-string", () => {
  assertThrows(() => asString(42));
  assertThrows(() => asString([sym("a")]));
});

Deno.test("asString - returns string unchanged", () => {
  assertEquals(asString("hello"), "hello");
});

Deno.test("asNumber - throws on non-number", () => {
  assertThrows(() => asNumber("42"));
  assertThrows(() => asNumber([sym("a")]));
});

Deno.test("asNumber - returns number unchanged", () => {
  assertEquals(asNumber(42), 42);
});
