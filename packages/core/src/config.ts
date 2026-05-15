import type {
  AdminConfigSnapshot,
  AppConfig,
  ModelMeta,
  ModelProvider,
} from "./types";

function escapeTomlKey(key: string): string {
  return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeTomlValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeConfig(raw: unknown): AppConfig {
  const cfg = raw as Partial<AppConfig>;
  return {
    providers: cfg.providers ?? {},
    models: cfg.models ?? {},
  };
}

export async function readGatewayConfig(
  configPath = "./config.toml"
): Promise<AppConfig> {
  const text = await Bun.file(configPath).text();
  return normalizeConfig(Bun.TOML.parse(text));
}

export async function readModelsMeta(
  metaPath = "./models-meta.json"
): Promise<Record<string, ModelMeta>> {
  const metaFile = Bun.file(metaPath);
  if (!(await metaFile.exists())) return {};
  return await metaFile.json();
}

export function serializeGatewayConfig(cfg: AppConfig): string {
  const lines: string[] = [];

  for (const [name, provider] of Object.entries(cfg.providers)) {
    lines.push(`[providers.${escapeTomlKey(name)}]`);
    lines.push(`baseUrl = "${escapeTomlValue(provider.baseUrl)}"`);
    lines.push(`authHeader = "${escapeTomlValue(provider.authHeader)}"`);
    lines.push(`keyEnvVar = "${escapeTomlValue(provider.keyEnvVar)}"`);
    lines.push("");
  }

  for (const [modelId, route] of Object.entries(cfg.models)) {
    for (const provider of route.providers) {
      lines.push(`[[models.${escapeTomlKey(modelId)}.providers]]`);
      lines.push(`name = "${escapeTomlValue(provider.name)}"`);
      lines.push(`remap = "${escapeTomlValue(provider.remap)}"`);
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeGatewayConfig(
  cfg: AppConfig,
  configPath = "./config.toml"
): Promise<void> {
  await Bun.write(configPath, serializeGatewayConfig(cfg));
}

export function addModelMappings(
  cfg: AppConfig,
  providerName: string,
  modelIds: string[]
): AppConfig {
  const next: AppConfig = structuredClone(cfg);

  for (const modelId of modelIds) {
    const route = (next.models[modelId] ??= { providers: [] });
    const existing = route.providers.find((provider) => provider.name === providerName);
    if (!existing) {
      route.providers.push({ name: providerName, remap: modelId });
    }
  }

  return next;
}

export function addModelProviderMapping(
  cfg: AppConfig,
  modelId: string,
  providerName: string,
  remap: string
): AppConfig {
  const next: AppConfig = structuredClone(cfg);
  const route = (next.models[modelId] ??= { providers: [] });
  const existing = route.providers.find((provider) => provider.name === providerName);

  if (existing) {
    existing.remap = remap;
  } else {
    route.providers.push({ name: providerName, remap });
  }

  return next;
}

export function reorderModelProviders(
  cfg: AppConfig,
  modelId: string,
  orderedProviderNames: string[]
): AppConfig {
  const route = cfg.models[modelId];
  if (!route) {
    throw new Error(`Model "${modelId}" does not exist`);
  }

  const byName = new Map(route.providers.map((provider) => [provider.name, provider]));
  const nextProviders: ModelProvider[] = [];

  for (const name of orderedProviderNames) {
    const provider = byName.get(name);
    if (!provider) {
      throw new Error(`Provider "${name}" is not mapped on model "${modelId}"`);
    }
    nextProviders.push(provider);
    byName.delete(name);
  }

  nextProviders.push(...byName.values());

  return {
    ...cfg,
    models: {
      ...cfg.models,
      [modelId]: {
        providers: nextProviders,
      },
    },
  };
}

export function toAdminConfigSnapshot(
  cfg: AppConfig,
  meta: Record<string, ModelMeta>,
  env: Record<string, string | undefined> = process.env
): AdminConfigSnapshot {
  return {
    providers: Object.entries(cfg.providers).map(([name, provider]) => ({
      name,
      baseUrl: provider.baseUrl,
      authHeader: provider.authHeader,
      keyEnvVar: provider.keyEnvVar,
      hasApiKey: Boolean(env[provider.keyEnvVar]),
    })),
    models: Object.entries(cfg.models).map(([id, route]) => ({
      id,
      providers: route.providers,
      contextWindow: meta[id]?.context_window,
      maxOutputTokens: meta[id]?.max_output_tokens,
    })),
  };
}
