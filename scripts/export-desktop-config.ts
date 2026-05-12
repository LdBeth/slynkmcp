/**
 * Emit a Claude Desktop `mcpServers` snippet for swankmcp on stdout.
 *
 * The default snippet points at the bundled `main.mjs` (run `deno task build`
 * first). Whitelisted env vars currently set in the shell are forwarded into
 * the snippet's `env` block so the user can pre-fill SLYNK_PORT etc. by
 * exporting them before running this script.
 */

import { fromFileUrl } from "@std/path";

const DEFAULT_NAME = "swankmcp";

const ENV_WHITELIST = [
  "SLYNK_HOST",
  "SLYNK_PORT",
  "CL_PACKAGE",
  "MAX_RESULT_CHARS",
  "LOG_LEVEL",
  "SWANKMCP_PLUGINS",
] as const;

export interface SnippetEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface Snippet {
  mcpServers: Record<string, SnippetEntry>;
}

export function buildSnippet(opts: {
  name: string;
  pluginFlags: string[];
  bundle: string;
  env: Record<string, string | undefined>;
}): Snippet {
  const args = ["run", "--allow-net", "--allow-env", opts.bundle];
  for (const p of opts.pluginFlags) args.push(`--plugin=${p}`);

  const envBlock: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const v = opts.env[key];
    if (v !== undefined && v !== "") envBlock[key] = v;
  }

  const entry: SnippetEntry = { command: "deno", args };
  if (Object.keys(envBlock).length > 0) entry.env = envBlock;

  return { mcpServers: { [opts.name]: entry } };
}

interface ParsedArgs {
  name: string;
  pluginFlags: string[];
  bundle: string;
  help: boolean;
}

export const _testParseArgs = (argv: string[]) => parseArgs(argv);

function parseArgs(argv: string[]): ParsedArgs {
  let name = DEFAULT_NAME;
  let bundleOverride: string | null = null;
  const pluginFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      continue;
    } else if (a === "-h" || a === "--help") {
      return { name, pluginFlags, bundle: "", help: true };
    } else if (a.startsWith("--name=")) {
      name = a.slice("--name=".length);
    } else if (a === "--name" && i + 1 < argv.length) {
      name = argv[++i];
    } else if (a.startsWith("--bundle=")) {
      bundleOverride = a.slice("--bundle=".length);
    } else if (a === "--bundle" && i + 1 < argv.length) {
      bundleOverride = argv[++i];
    } else if (a.startsWith("--plugin=")) {
      const v = a.slice("--plugin=".length).trim();
      if (v) pluginFlags.push(v);
    } else if (a === "--plugin" && i + 1 < argv.length) {
      const v = argv[++i].trim();
      if (v) pluginFlags.push(v);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  const bundle = bundleOverride ??
    fromFileUrl(new URL("../main.mjs", import.meta.url));
  return { name, pluginFlags, bundle, help: false };
}

const USAGE = `Usage: deno task export-config -- [flags]

Emit a Claude Desktop mcpServers snippet for swankmcp on stdout. Paste the
result into ~/Library/Application Support/Claude/claude_desktop_config.json
(macOS) or the equivalent on your platform.

Flags:
  --name=<id>          Server key in mcpServers (default: ${DEFAULT_NAME})
  --plugin=<name>      Activate a swankmcp plugin (repeatable)
  --bundle=<abs-path>  Path to the bundled main.mjs (default: ./main.mjs)
  -h, --help           Show this help

Whitelisted env vars currently exported in the shell are copied into the
snippet's "env" block: ${ENV_WHITELIST.join(", ")}.

Run \`deno task build\` first so the bundled main.mjs exists.
`;

if (import.meta.main) {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(Deno.args);
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    Deno.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);
    Deno.exit(0);
  }
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_WHITELIST) env[key] = Deno.env.get(key);
  const snippet = buildSnippet({
    name: parsed.name,
    pluginFlags: parsed.pluginFlags,
    bundle: parsed.bundle,
    env,
  });
  console.log(JSON.stringify(snippet, null, 2));
}
