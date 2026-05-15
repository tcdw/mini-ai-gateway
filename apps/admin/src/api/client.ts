import type {
  AdminConfigSnapshot,
  ClientConfigKind,
  ProviderModel,
} from "@mini-ai-gateway/core";

interface AddMappingsInput {
  provider: string;
  modelIds: string[];
}

interface AddMappingInput {
  targetModelId: string;
  provider: string;
  remap: string;
}

interface ReorderProvidersInput {
  modelId: string;
  providers: string[];
}

interface GeneratedConfigInput {
  kind: ClientConfigKind;
  baseUrl: string;
  apiKeyEnvVar: string;
  defaultModel: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("mini-ai-gateway.gatewayApiKey");
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const body = (await res
      .json()
      .catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }

  return (await res.json()) as T;
}

export function getConfig() {
  return request<AdminConfigSnapshot>("/admin/api/config");
}

export function scanProviderModels(provider: string) {
  return request<{ data: ProviderModel[] }>(
    `/admin/api/providers/${encodeURIComponent(provider)}/models/scan`,
    { method: "POST", body: "{}" }
  );
}

export function addMappings(input: AddMappingsInput) {
  return request<AdminConfigSnapshot>("/admin/api/models/mappings", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function addMapping(input: AddMappingInput) {
  return request<AdminConfigSnapshot>(
    `/admin/api/models/${encodeURIComponent(input.targetModelId)}/providers`,
    {
      method: "POST",
      body: JSON.stringify({ provider: input.provider, remap: input.remap }),
    }
  );
}

export function reorderProviders(input: ReorderProvidersInput) {
  return request<AdminConfigSnapshot>(
    `/admin/api/models/${encodeURIComponent(input.modelId)}/providers`,
    {
      method: "PATCH",
      body: JSON.stringify({ providers: input.providers }),
    }
  );
}

export function generateClientConfig(input: GeneratedConfigInput) {
  return request<{ text: string }>("/admin/api/client-config", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
