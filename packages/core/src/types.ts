export type Protocol = "openai" | "openai-responses" | "anthropic" | "gemini";

export const PROTOCOLS: readonly Protocol[] = [
  "openai",
  "openai-responses",
  "anthropic",
  "gemini",
] as const;

export interface ProtocolEndpoint {
  baseUrl: string;
  /**
   * Optional override for the auth header name / prefix.
   * - "Authorization" or "Bearer" → "Authorization: Bearer <key>"
   * - "x-api-key" → "x-api-key: <key>"  (Anthropic native)
   * - "x-goog-api-key" → "x-goog-api-key: <key>"  (Gemini)
   * If omitted, defaults per protocol:
   *   openai           → "Bearer"
   *   openai-responses → "Bearer"
   *   anthropic        → "Bearer"
   *   gemini           → "x-goog-api-key"
   */
  authHeader?: string;
}

export interface ProviderConfig {
  keyEnvVar: string;
  endpoints: Partial<Record<Protocol, ProtocolEndpoint>>;
}

export interface ModelProvider {
  name: string;
  remap: string;
}

export interface ProtocolRoute {
  providers: ModelProvider[];
}

export interface ModelRoute {
  protocols: Partial<Record<Protocol, ProtocolRoute>>;
}

export interface AppConfig {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelRoute>;
}

export interface ModelMeta {
  id: string;
  name: string;
  context_window: number;
  max_output_tokens: number;
  modalities?: {
    input: string[];
    output: string[];
  };
}

export interface ProviderModel {
  id: string;
  owned_by?: string;
}

export interface ModelsListResponse {
  data: ProviderModel[];
}

export interface AdminProtocolEndpoint {
  baseUrl: string;
  authHeader?: string;
}

export interface AdminProvider {
  name: string;
  keyEnvVar: string;
  hasApiKey: boolean;
  endpoints: Partial<Record<Protocol, AdminProtocolEndpoint>>;
}

export interface AdminProtocolRoute {
  providers: ModelProvider[];
}

export interface AdminModelRoute {
  id: string;
  protocols: Partial<Record<Protocol, AdminProtocolRoute>>;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface AdminConfigSnapshot {
  providers: AdminProvider[];
  models: AdminModelRoute[];
}
