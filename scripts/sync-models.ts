import { readGatewayConfig } from "@mini-ai-gateway/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelsDevModel {
  id: string;
  name: string;
  limit?: { context?: number; output?: number };
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

interface ModelsDevProvider {
  id: string;
  name: string;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevData = Record<string, ModelsDevProvider>;

interface ModelMeta {
  id: string;
  name: string;
  context_window: number;
  max_output_tokens: number;
  modalities?: {
    input: string[];
    output: string[];
  };
}

type MetaFile = Record<string, ModelMeta>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenModels(data: ModelsDevData): Record<string, ModelsDevModel> {
  const flat: Record<string, ModelsDevModel> = {};
  for (const [, provider] of Object.entries(data)) {
    if (!provider.models) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      // Prefer first occurrence; don't overwrite
      if (!flat[modelId]) {
        flat[modelId] = model;
      }
    }
  }
  return flat;
}

function normalizeModalities(
  modalities: ModelsDevModel["modalities"]
): ModelMeta["modalities"] | undefined {
  if (!modalities) return undefined;
  if (!Array.isArray(modalities.input) || !Array.isArray(modalities.output)) {
    return undefined;
  }

  return {
    input: modalities.input.filter((value) => typeof value === "string"),
    output: modalities.output.filter((value) => typeof value === "string"),
  };
}

function buildModelMeta(modelId: string, found: ModelsDevModel): ModelMeta {
  const modalities = normalizeModalities(found.modalities);

  return {
    id: modelId,
    name: found.name || modelId,
    context_window: found.limit?.context || 8192,
    max_output_tokens: found.limit?.output || 4096,
    ...(modalities ? { modalities } : {}),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const config = await readGatewayConfig();

  // ------------------------------------------------------------------
  // Load existing meta (preserve entries that are no longer in config)
  // ------------------------------------------------------------------
  const metaFile = Bun.file("./models-meta.json");
  let existingMeta: MetaFile = {};
  if (await metaFile.exists()) {
    existingMeta = await metaFile.json();
    console.log(
      `[Sync] Loaded existing meta: ${Object.keys(existingMeta).length} entries`
    );
  }

  // ------------------------------------------------------------------
  // Fetch models.dev
  // ------------------------------------------------------------------
  console.log("[Sync] Fetching https://models.dev/api.json ...");
  const res = await fetch("https://models.dev/api.json");
  if (!res.ok) {
    console.error(`[Sync] Failed to fetch models.dev: ${res.status}`);
    process.exit(1);
  }
  const devData = (await res.json()) as ModelsDevData;

  // Flatten: walk every provider's models dict into a single lookup map
  const flat = flattenModels(devData);
  let totalModelEntries = 0;
  for (const [, provider] of Object.entries(devData)) {
    if (provider.models) totalModelEntries += Object.keys(provider.models).length;
  }
  console.log(
    `[Sync] Loaded ${Object.keys(devData).length} providers, ${totalModelEntries} models from models.dev`
  );

  // ------------------------------------------------------------------
  // Match config models → models.dev entries
  // ------------------------------------------------------------------
  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const [modelId, route] of Object.entries(config.models)) {
    // Build a list of candidate IDs to try:
    //   1) the config key itself (e.g. "openai/gpt-5.1")
    //   2) the portion after the last "/" (e.g. "gpt-5.1")
    //   3) each provider's remap field
    const lookupIds: string[] = [modelId];

    const shortName = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
    if (shortName !== modelId && !lookupIds.includes(shortName)) {
      lookupIds.push(shortName);
    }

    for (const p of route.providers) {
      if (p.remap && !lookupIds.includes(p.remap)) {
        lookupIds.push(p.remap);
      }
      const remapShort = p.remap?.includes("/") ? p.remap.split("/").pop()! : p.remap;
      if (remapShort && !lookupIds.includes(remapShort)) {
        lookupIds.push(remapShort);
      }
    }

    let found: ModelsDevModel | undefined;
    for (const lid of lookupIds) {
      if (flat[lid]) {
        found = flat[lid];
        break;
      }
    }

    if (found) {
      const nextMeta = buildModelMeta(modelId, found);
      const previousMeta = existingMeta[modelId];
      const changed =
        !previousMeta ||
        JSON.stringify(previousMeta) !== JSON.stringify(nextMeta);

      existingMeta[modelId] = nextMeta;
      if (changed) {
        updated++;
      } else {
        skipped++;
      }
      console.log(`[Sync] ✓ ${modelId}  ←  ${found.id}`);
    } else {
      notFound++;
      console.warn(
        `[Sync] ✗ ${modelId} — not found (tried: ${lookupIds.join(", ")})`
      );
    }
  }

  console.log(
    `[Sync] Done — updated: ${updated}, skipped: ${skipped}, not found: ${notFound}`
  );

  // ------------------------------------------------------------------
  // Write back
  // ------------------------------------------------------------------
  await Bun.write("./models-meta.json", `${JSON.stringify(existingMeta, null, 2)}\n`);
  console.log("[Sync] Written to models-meta.json");
}

main();
