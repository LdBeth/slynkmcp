import type { Plugin } from "./types.ts";
import { opusmodusPlugin } from "./opusmodus.ts";
import { inspectorPlugin } from "./inspector.ts";

/**
 * Hard-coded registry of in-tree plugins. Keys are the names users pass to
 * `--plugin=` / `SWANKMCP_PLUGINS`.
 */
export const PLUGINS: Record<string, Plugin> = {
  opusmodus: opusmodusPlugin,
  inspector: inspectorPlugin,
};

/**
 * Resolve a list of plugin names against `registry`. Order is preserved;
 * duplicate names yield the plugin once. An unknown name throws an Error
 * naming the offender and listing the known plugin names.
 */
export function loadPlugins(
  names: string[],
  registry: Record<string, Plugin> = PLUGINS,
): Plugin[] {
  const out: Plugin[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    const plugin = registry[name];
    if (!plugin) {
      const known = Object.keys(registry).sort().join(", ") || "(none)";
      throw new Error(`unknown plugin "${name}"; known plugins: ${known}`);
    }
    seen.add(name);
    out.push(plugin);
  }
  return out;
}
