import { assertEquals } from "@std/assert";
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
