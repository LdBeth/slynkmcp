import { assertEquals, assertStringIncludes } from "@std/assert";
import { formatEvalResult } from "./tool_helpers.ts";

Deno.test("formatEvalResult: plain value", () => {
  assertEquals(formatEvalResult({ value: "42", output: "" }), "42");
});

Deno.test("formatEvalResult: value with captured stdout", () => {
  assertEquals(
    formatEvalResult({ value: "42", output: "hello\n" }),
    "[stdout]\nhello\n\n[value]\n42",
  );
});

Deno.test("formatEvalResult: debugEntered renders a suspended-eval notice", () => {
  const s = formatEvalResult({ value: "", output: "", debugEntered: true });
  assertStringIncludes(s, "suspended in the debugger");
  assertStringIncludes(s, "lisp_debug_");
});
