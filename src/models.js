import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Codex CLI caches the account's available model slugs next to auth.json.
// If it's missing (fresh install, never run `codex` yet), report an empty list.
export async function listModels(authPath) {
  try {
    const cachePath = join(dirname(authPath), "models_cache.json");
    const raw = await readFile(cachePath, "utf8");
    const data = JSON.parse(raw);
    return (data.models ?? []).map((m) => ({
      id: m.slug,
      object: "model",
      owned_by: "codex",
    }));
  } catch {
    return [];
  }
}
