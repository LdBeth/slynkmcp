import { loadConfig } from "./src/config.ts";
import { runServer } from "./src/mcp/server.ts";

/**
 * Parse `--plugin=<name>` repeatable args from argv. Bare `--plugin <name>`
 * (space-separated) is also accepted.
 */
function parsePluginArgs(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--plugin=")) {
      const v = a.slice("--plugin=".length).trim();
      if (v) out.push(v);
    } else if (a === "--plugin" && i + 1 < argv.length) {
      const v = argv[++i].trim();
      if (v) out.push(v);
    }
  }
  return out;
}

if (import.meta.main) {
  const config = loadConfig();
  const cliPlugins = parsePluginArgs(Deno.args);
  config.plugins = [...config.plugins, ...cliPlugins];
  try {
    await runServer(config);
  } catch (err) {
    console.error("swankmcp fatal:", err);
    Deno.exit(1);
  }
}
