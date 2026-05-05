import { loadConfig } from "./src/config.ts";
import { runServer } from "./src/mcp/server.ts";

if (import.meta.main) {
  const config = loadConfig();
  try {
    await runServer(config);
  } catch (err) {
    console.error("swankmcp fatal:", err);
    Deno.exit(1);
  }
}
