export interface Config {
  host: string;
  port: number;
  defaultPackage: string;
  maxResultChars: number;
  /** Backtrace frames included in a Lisp error report. */
  debugFrames: number;
  /** Innermost frames to ask Slynk for a source location. */
  debugSources: number;
  plugins: string[];
}

function envInt(name: string, fallback: number, min = 1): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
  }
  if (n < min) {
    throw new Error(`${name} must be >= ${min}: got ${n}`);
  }
  return n;
}

function envList(name: string): string[] {
  const raw = Deno.env.get(name);
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

export function loadConfig(): Config {
  return {
    host: Deno.env.get("SLYNK_HOST") ?? "localhost",
    port: envInt("SLYNK_PORT", 4005),
    defaultPackage: Deno.env.get("CL_PACKAGE") ?? "cl-user",
    maxResultChars: envInt("MAX_RESULT_CHARS", 8000),
    // Above slynk's *sly-db-initial-frames* (20), which field testing showed
    // cuts real frames off deep stacks; the extra frames cost one
    // `slynk:backtrace` round trip. Source lookups cost one round trip per
    // frame, so only the innermost few are probed — the frame that places the
    // error in a file is normally among them.
    debugFrames: envInt("SLYNK_DEBUG_FRAMES", 32, 0),
    debugSources: envInt("SLYNK_DEBUG_SOURCES", 8, 0),
    plugins: envList("SWANKMCP_PLUGINS"),
  };
}
