import type { AppConfig, ModelsListResponse, ProviderModel } from "./types";

export async function scanProviderModels(
  cfg: AppConfig,
  providerName: string,
  env: Record<string, string | undefined> = process.env
): Promise<ProviderModel[]> {
  const provider = cfg.providers[providerName];
  if (!provider) {
    throw new Error(`Provider "${providerName}" does not exist`);
  }

  const headers: Record<string, string> = {};
  const apiKey = env[provider.keyEnvVar];
  if (apiKey) {
    headers.Authorization = `${provider.authHeader} ${apiKey}`;
  }

  const res = await fetch(`${provider.baseUrl}/models`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as ModelsListResponse;
  if (!Array.isArray(data.data)) {
    throw new Error("Unexpected /models response shape");
  }

  return data.data;
}
