import type {
  AdminConfigSnapshot,
  ClientConfigKind,
  Protocol,
  ProtocolEndpoint,
  ProviderModel,
} from "@mini-ai-gateway/core";

interface ScanInput {
  provider: string;
  protocol: Protocol;
}

interface AddMappingsInput {
  provider: string;
  protocol: Protocol;
  modelIds: string[];
}

interface AddMappingInput {
  targetModelId: string;
  provider: string;
  protocol: Protocol;
  remap: string;
}

interface RemoveMappingInput {
  modelId: string;
  provider: string;
  protocol: Protocol;
}

interface ReorderProvidersInput {
  modelId: string;
  protocol: Protocol;
  providers: string[];
}

interface UpsertEndpointInput {
  provider: string;
  protocol: Protocol;
  endpoint: ProtocolEndpoint;
}

interface RemoveEndpointInput {
  provider: string;
  protocol: Protocol;
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

export function scanProviderModels(input: ScanInput) {
  return request<{ data: ProviderModel[]; protocol: Protocol }>(
    `/admin/api/providers/${encodeURIComponent(input.provider)}/models/scan`,
    {
      method: "POST",
      body: JSON.stringify({ protocol: input.protocol }),
    },
  );
}

export function upsertProviderEndpoint(input: UpsertEndpointInput) {
  return request<AdminConfigSnapshot>(
    `/admin/api/providers/${encodeURIComponent(
      input.provider,
    )}/endpoints/${input.protocol}`,
    {
      method: "PATCH",
      body: JSON.stringify(input.endpoint),
    },
  );
}

export function removeProviderEndpoint(input: RemoveEndpointInput) {
  return request<AdminConfigSnapshot>(
    `/admin/api/providers/${encodeURIComponent(
      input.provider,
    )}/endpoints/${input.protocol}`,
    { method: "DELETE" },
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
      body: JSON.stringify({
        provider: input.provider,
        protocol: input.protocol,
        remap: input.remap,
      }),
    },
  );
}

export function removeMapping(input: RemoveMappingInput) {
  return request<AdminConfigSnapshot>(
    `/admin/api/models/${encodeURIComponent(input.modelId)}/providers`,
    {
      method: "DELETE",
      body: JSON.stringify({
        provider: input.provider,
        protocol: input.protocol,
      }),
    },
  );
}

export function reorderProviders(input: ReorderProvidersInput) {
  return request<AdminConfigSnapshot>(
    `/admin/api/models/${encodeURIComponent(input.modelId)}/providers`,
    {
      method: "PATCH",
      body: JSON.stringify({
        protocol: input.protocol,
        providers: input.providers,
      }),
    },
  );
}

export function generateClientConfig(input: GeneratedConfigInput) {
  return request<{ text: string }>("/admin/api/client-config", {
    method: "POST",
    body: JSON.stringify(input),
  });
}
