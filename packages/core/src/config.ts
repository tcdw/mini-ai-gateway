import type {
  AdminConfigSnapshot,
  AppConfig,
  ModelMeta,
  ModelProvider,
  ModelRoute,
  Protocol,
  ProtocolEndpoint,
  ProtocolRoute,
  ProviderConfig,
} from "./types";
import { PROTOCOLS } from "./types";

function escapeTomlKey(key: string): string {
  return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function escapeTomlValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

interface LegacyProviderConfig {
  baseUrl?: string;
  authHeader?: string;
  keyEnvVar?: string;
  endpoints?: Partial<Record<Protocol, ProtocolEndpoint>>;
}

interface LegacyModelRoute {
  providers?: ModelProvider[];
  protocols?: Partial<Record<Protocol, ProtocolRoute>>;
}

interface LegacyAppConfig {
  providers?: Record<string, LegacyProviderConfig>;
  models?: Record<string, LegacyModelRoute>;
}

function normalizeProvider(raw: LegacyProviderConfig): ProviderConfig {
  const endpoints: Partial<Record<Protocol, ProtocolEndpoint>> = {
    ...(raw.endpoints ?? {}),
  };

  // Legacy compatibility: a flat baseUrl+authHeader gets mapped to openai endpoint
  if (raw.baseUrl && !endpoints.openai) {
    endpoints.openai = {
      baseUrl: raw.baseUrl,
      ...(raw.authHeader ? { authHeader: raw.authHeader } : {}),
    };
  }

  return {
    keyEnvVar: raw.keyEnvVar ?? "",
    endpoints,
  };
}

function normalizeModelRoute(raw: LegacyModelRoute): ModelRoute {
  const protocols: Partial<Record<Protocol, ProtocolRoute>> = {};

  if (raw.protocols) {
    for (const [proto, route] of Object.entries(raw.protocols)) {
      if (!isProtocol(proto)) continue;
      if (!route || !Array.isArray(route.providers)) continue;
      protocols[proto] = { providers: route.providers };
    }
  }

  // Legacy compatibility: a flat providers array gets mapped to openai protocol
  if (Array.isArray(raw.providers) && raw.providers.length > 0 && !protocols.openai) {
    protocols.openai = { providers: raw.providers };
  }

  return { protocols };
}

function isProtocol(value: string): value is Protocol {
  return (PROTOCOLS as readonly string[]).includes(value);
}

function normalizeConfig(raw: unknown): AppConfig {
  const cfg = (raw ?? {}) as LegacyAppConfig;
  const providers: Record<string, ProviderConfig> = {};
  const models: Record<string, ModelRoute> = {};

  for (const [name, provider] of Object.entries(cfg.providers ?? {})) {
    providers[name] = normalizeProvider(provider);
  }

  for (const [id, route] of Object.entries(cfg.models ?? {})) {
    models[id] = normalizeModelRoute(route);
  }

  return { providers, models };
}

export async function readGatewayConfig(
  configPath = "./config.toml",
): Promise<AppConfig> {
  const text = await Bun.file(configPath).text();
  return normalizeConfig(Bun.TOML.parse(text));
}

export async function readModelsMeta(
  metaPath = "./models-meta.json",
): Promise<Record<string, ModelMeta>> {
  const metaFile = Bun.file(metaPath);
  if (!(await metaFile.exists())) return {};
  return await metaFile.json();
}

export function serializeGatewayConfig(cfg: AppConfig): string {
  const lines: string[] = [];

  for (const [name, provider] of Object.entries(cfg.providers)) {
    lines.push(`[providers.${escapeTomlKey(name)}]`);
    lines.push(`keyEnvVar = "${escapeTomlValue(provider.keyEnvVar)}"`);
    lines.push("");

    for (const proto of PROTOCOLS) {
      const endpoint = provider.endpoints[proto];
      if (!endpoint) continue;
      lines.push(
        `[providers.${escapeTomlKey(name)}.endpoints.${proto}]`,
      );
      lines.push(`baseUrl = "${escapeTomlValue(endpoint.baseUrl)}"`);
      if (endpoint.authHeader) {
        lines.push(`authHeader = "${escapeTomlValue(endpoint.authHeader)}"`);
      }
      lines.push("");
    }
  }

  for (const [modelId, route] of Object.entries(cfg.models)) {
    for (const proto of PROTOCOLS) {
      const protoRoute = route.protocols[proto];
      if (!protoRoute) continue;
      for (const provider of protoRoute.providers) {
        lines.push(
          `[[models.${escapeTomlKey(modelId)}.protocols.${proto}.providers]]`,
        );
        lines.push(`name = "${escapeTomlValue(provider.name)}"`);
        lines.push(`remap = "${escapeTomlValue(provider.remap)}"`);
        lines.push("");
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeGatewayConfig(
  cfg: AppConfig,
  configPath = "./config.toml",
): Promise<void> {
  await Bun.write(configPath, serializeGatewayConfig(cfg));
}

function ensureProtocolRoute(route: ModelRoute, proto: Protocol): ProtocolRoute {
  if (!route.protocols[proto]) {
    route.protocols[proto] = { providers: [] };
  }
  return route.protocols[proto]!;
}

export function addModelMappings(
  cfg: AppConfig,
  providerName: string,
  protocol: Protocol,
  modelIds: string[],
): AppConfig {
  const next: AppConfig = structuredClone(cfg);

  for (const modelId of modelIds) {
    const route = (next.models[modelId] ??= { protocols: {} });
    const protoRoute = ensureProtocolRoute(route, protocol);
    const existing = protoRoute.providers.find(
      (provider) => provider.name === providerName,
    );
    if (!existing) {
      protoRoute.providers.push({ name: providerName, remap: modelId });
    }
  }

  return next;
}

export function addModelProviderMapping(
  cfg: AppConfig,
  modelId: string,
  protocol: Protocol,
  providerName: string,
  remap: string,
): AppConfig {
  const next: AppConfig = structuredClone(cfg);
  const route = (next.models[modelId] ??= { protocols: {} });
  const protoRoute = ensureProtocolRoute(route, protocol);
  const existing = protoRoute.providers.find(
    (provider) => provider.name === providerName,
  );

  if (existing) {
    existing.remap = remap;
  } else {
    protoRoute.providers.push({ name: providerName, remap });
  }

  return next;
}

export function removeModelProviderMapping(
  cfg: AppConfig,
  modelId: string,
  protocol: Protocol,
  providerName: string,
): AppConfig {
  const next: AppConfig = structuredClone(cfg);
  const route = next.models[modelId];
  if (!route) return next;
  const protoRoute = route.protocols[protocol];
  if (!protoRoute) return next;

  protoRoute.providers = protoRoute.providers.filter(
    (provider) => provider.name !== providerName,
  );

  if (protoRoute.providers.length === 0) {
    delete route.protocols[protocol];
  }

  // Clean up the model entry entirely if no protocols remain
  if (Object.keys(route.protocols).length === 0) {
    delete next.models[modelId];
  }

  return next;
}

export function reorderModelProviders(
  cfg: AppConfig,
  modelId: string,
  protocol: Protocol,
  orderedProviderNames: string[],
): AppConfig {
  const route = cfg.models[modelId];
  if (!route) {
    throw new Error(`Model "${modelId}" does not exist`);
  }
  const protoRoute = route.protocols[protocol];
  if (!protoRoute) {
    throw new Error(
      `Model "${modelId}" has no providers under protocol "${protocol}"`,
    );
  }

  const byName = new Map(
    protoRoute.providers.map((provider) => [provider.name, provider]),
  );
  const nextProviders: ModelProvider[] = [];

  for (const name of orderedProviderNames) {
    const provider = byName.get(name);
    if (!provider) {
      throw new Error(
        `Provider "${name}" is not mapped on model "${modelId}" / protocol "${protocol}"`,
      );
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
        ...route,
        protocols: {
          ...route.protocols,
          [protocol]: { providers: nextProviders },
        },
      },
    },
  };
}

export function upsertProviderEndpoint(
  cfg: AppConfig,
  providerName: string,
  protocol: Protocol,
  endpoint: ProtocolEndpoint,
): AppConfig {
  const next: AppConfig = structuredClone(cfg);
  const provider = next.providers[providerName];
  if (!provider) {
    throw new Error(`Provider "${providerName}" does not exist`);
  }
  provider.endpoints[protocol] = { ...endpoint };
  return next;
}

export function removeProviderEndpoint(
  cfg: AppConfig,
  providerName: string,
  protocol: Protocol,
): AppConfig {
  const next: AppConfig = structuredClone(cfg);
  const provider = next.providers[providerName];
  if (!provider) return next;
  delete provider.endpoints[protocol];
  return next;
}

export function toAdminConfigSnapshot(
  cfg: AppConfig,
  meta: Record<string, ModelMeta>,
  env: Record<string, string | undefined> = process.env,
): AdminConfigSnapshot {
  return {
    providers: Object.entries(cfg.providers).map(([name, provider]) => ({
      name,
      keyEnvVar: provider.keyEnvVar,
      hasApiKey: Boolean(env[provider.keyEnvVar]),
      endpoints: Object.fromEntries(
        (Object.entries(provider.endpoints) as [Protocol, ProtocolEndpoint][])
          .filter(([, endpoint]) => endpoint)
          .map(([proto, endpoint]) => [
            proto,
            {
              baseUrl: endpoint.baseUrl,
              ...(endpoint.authHeader ? { authHeader: endpoint.authHeader } : {}),
            },
          ]),
      ),
    })),
    models: Object.entries(cfg.models).map(([id, route]) => ({
      id,
      protocols: Object.fromEntries(
        (Object.entries(route.protocols) as [Protocol, ProtocolRoute][])
          .filter(([, proto]) => proto)
          .map(([proto, value]) => [
            proto,
            { providers: value.providers },
          ]),
      ),
      contextWindow: meta[id]?.context_window,
      maxOutputTokens: meta[id]?.max_output_tokens,
    })),
  };
}
