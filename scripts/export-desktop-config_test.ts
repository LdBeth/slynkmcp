import { assertEquals } from "@std/assert";
import { buildSnippet } from "./export-desktop-config.ts";

Deno.test("buildSnippet: minimal — no plugins, no env, no env block emitted", () => {
  const snippet = buildSnippet({
    name: "swankmcp",
    pluginFlags: [],
    bundle: "/abs/main.mjs",
    env: {},
  });
  assertEquals(snippet, {
    mcpServers: {
      swankmcp: {
        command: "deno",
        args: ["run", "--allow-net", "--allow-env", "/abs/main.mjs"],
      },
    },
  });
});

Deno.test("buildSnippet: forwards plugins as --plugin=<name> args after the bundle", () => {
  const snippet = buildSnippet({
    name: "swankmcp",
    pluginFlags: ["opusmodus", "inspector"],
    bundle: "/abs/main.mjs",
    env: {},
  });
  assertEquals(snippet.mcpServers.swankmcp.args, [
    "run",
    "--allow-net",
    "--allow-env",
    "/abs/main.mjs",
    "--plugin=opusmodus",
    "--plugin=inspector",
  ]);
});

Deno.test("buildSnippet: emits whitelisted env, ignores non-whitelisted, skips unset", () => {
  const snippet = buildSnippet({
    name: "swankmcp",
    pluginFlags: [],
    bundle: "/abs/main.mjs",
    env: {
      SLYNK_PORT: "4005",
      SLYNK_HOST: undefined,
      RANDOM_OTHER_VAR: "ignored",
    },
  });
  assertEquals(snippet.mcpServers.swankmcp.env, { SLYNK_PORT: "4005" });
});

Deno.test("buildSnippet: omits env block when no whitelisted var is set", () => {
  const snippet = buildSnippet({
    name: "swankmcp",
    pluginFlags: [],
    bundle: "/abs/main.mjs",
    env: { RANDOM_OTHER_VAR: "ignored" },
  });
  assertEquals(snippet.mcpServers.swankmcp.env, undefined);
});

Deno.test("buildSnippet: respects custom name", () => {
  const snippet = buildSnippet({
    name: "swankmcp-om",
    pluginFlags: ["opusmodus"],
    bundle: "/abs/main.mjs",
    env: {},
  });
  assertEquals(Object.keys(snippet.mcpServers), ["swankmcp-om"]);
});

Deno.test("parseArgs: skips bare -- separator (deno task forwarding)", async () => {
  const { _testParseArgs } = await import("./export-desktop-config.ts");
  const parsed = _testParseArgs(["--", "--plugin=opusmodus", "--name=foo"]);
  assertEquals(parsed.help, false);
  assertEquals(parsed.name, "foo");
  assertEquals(parsed.pluginFlags, ["opusmodus"]);
});

Deno.test("buildSnippet: treats empty-string env values as unset", () => {
  const snippet = buildSnippet({
    name: "swankmcp",
    pluginFlags: [],
    bundle: "/abs/main.mjs",
    env: { SLYNK_PORT: "" },
  });
  assertEquals(snippet.mcpServers.swankmcp.env, undefined);
});
