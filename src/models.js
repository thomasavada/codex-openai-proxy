import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_IMAGE_ORCHESTRATOR } from "./convert.js";

// Codex CLI caches the account's available model slugs next to auth.json.
async function readModelCache(authPath) {
  const cachePath = join(dirname(authPath), "models_cache.json");
  const data = JSON.parse(await readFile(cachePath, "utf8"));
  return data.models ?? [];
}

// If it's missing (fresh install, never run `codex` yet), report an empty list.
export async function listModels(authPath) {
  try {
    return (await readModelCache(authPath)).map((m) => ({
      id: m.slug,
      object: "model",
      owned_by: "codex",
    }));
  } catch {
    return [];
  }
}

// Cheapest-first: the orchestrator only has to call the image tool, so a small
// model is plenty. Slugs come and go with the account, hence the live lookup —
// a hard-coded default silently 400s every image request once it is retired.
const ORCHESTRATOR_PREFERENCE = [
  DEFAULT_IMAGE_ORCHESTRATOR,
  "gpt-5.4-mini",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-6-astra",
];

export async function resolveImageOrchestrator(authPath) {
  try {
    const models = await readModelCache(authPath);
    const usable = new Set(models.filter((m) => m.supported_in_api !== false).map((m) => m.slug));
    const preferred = ORCHESTRATOR_PREFERENCE.find((slug) => usable.has(slug));
    if (preferred) return preferred;
    const first = models.find((m) => m.supported_in_api !== false)?.slug;
    if (first) return first;
  } catch {
    // Fall through to the compiled-in default.
  }
  return DEFAULT_IMAGE_ORCHESTRATOR;
}
