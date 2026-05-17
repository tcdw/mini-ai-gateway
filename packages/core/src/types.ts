export interface ProviderConfig {
  baseUrl: string;
  authHeader: string;
  keyEnvVar: string;
}

export interface ModelProvider {
  name: string;
  remap: string;
}

export interface ModelRoute {
  providers: ModelProvider[];
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

export interface AdminModelRoute {
  id: string;
  providers: ModelProvider[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface AdminProvider {
  name: string;
  baseUrl: string;
  authHeader: string;
  keyEnvVar: string;
  hasApiKey: boolean;
}

export interface AdminConfigSnapshot {
  providers: AdminProvider[];
  models: AdminModelRoute[];
}
