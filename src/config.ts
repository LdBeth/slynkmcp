export interface Config {
  host: string;
  port: number;
  defaultPackage: string;
  maxResultChars: number;
  plugins: string[];
}

function envStr(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid integer for ${name}: ${raw}`);
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
    host: envStr("SLYNK_HOST", "localhost"),
    port: envInt("SLYNK_PORT", 4005),
    defaultPackage: envStr("CL_PACKAGE", "cl-user"),
    maxResultChars: envInt("MAX_RESULT_CHARS", 8000),
    plugins: envList("SWANKMCP_PLUGINS"),
  };
}
