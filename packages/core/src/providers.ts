import type { AppConfig, ModelsListResponse, Protocol, ProviderModel } from "./types";
import { buildAuthHeaders } from "./protocol";

export async function scanProviderModels(
  cfg: AppConfig,
  providerName: string,
  protocol: Protocol = "openai",
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderModel[]> {
  const provider = cfg.providers[providerName];
  if (!provider) {
    throw new Error(`Provider "${providerName}" does not exist`);
  }

  const endpoint = provider.endpoints[protocol];
  if (!endpoint) {
    throw new Error(
      `Provider "${providerName}" has no endpoint configured for protocol "${protocol}"`,
    );
  }

  const apiKey = env[provider.keyEnvVar];
  const headers: Record<string, string> = {};
  if (apiKey) {
    Object.assign(headers, buildAuthHeaders(endpoint, protocol, apiKey));
  }

  // Both OpenAI and Gemini expose a list endpoint; Anthropic doesn't have a
  // standard one, so a request to `/models` may simply fail for that protocol.
  const listPath = protocol === "gemini" ? "/v1beta/models" : "/models";
  const res = await fetch(`${endpoint.baseUrl}${listPath}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    );
  }

  if (protocol === "gemini") {
    const data = (await res.json()) as {
      models?: { name: string }[];
    };
    if (!Array.isArray(data.models)) {
      throw new Error("Unexpected Gemini /v1beta/models response shape");
    }
    return data.models.map((model) => ({
      id: model.name.replace(/^models\//, ""),
    }));
  }

  const data = (await res.json()) as ModelsListResponse;
  if (!Array.isArray(data.data)) {
    throw new Error("Unexpected /models response shape");
  }
  return data.data;
}
