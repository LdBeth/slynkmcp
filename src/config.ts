export interface Config {
  host: string;
  port: number;
  defaultPackage: string;
  maxResultChars: number;
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

export function loadConfig(): Config {
  return {
    host: envStr("SLYNK_HOST", "localhost"),
    port: envInt("SLYNK_PORT", 4005),
    defaultPackage: envStr("OM_PACKAGE", "om"),
    maxResultChars: envInt("MAX_RESULT_CHARS", 8000),
  };
}
