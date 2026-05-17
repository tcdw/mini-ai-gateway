import adminIndex from "./apps/admin/index.html";
import {
  addModelMappings,
  addModelProviderMapping,
  buildAuthHeaders,
  buildProtocolErrorBody,
  generateClientConfig,
  pickDefaultModel,
  readGatewayConfig,
  readModelsMeta,
  removeModelProviderMapping,
  removeProviderEndpoint,
  reorderModelProviders,
  scanProviderModels,
  toAdminConfigSnapshot,
  upsertProviderEndpoint,
  writeGatewayConfig,
} from "@mini-ai-gateway/core";
import type {
  AppConfig,
  ModelMeta,
  Protocol,
  ProtocolEndpoint,
} from "@mini-ai-gateway/core";

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

const GATEWAY_KEY = process.env.GATEWAY_API_KEY;
if (!GATEWAY_KEY) {
  console.error("[Gateway] Fatal: GATEWAY_API_KEY is not set in .env");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000");
let cfg: AppConfig = await readGatewayConfig();

// Warn about missing provider keys (non-fatal — will be handled per-request)
for (const [name, p] of Object.entries(cfg.providers)) {
  if (!process.env[p.keyEnvVar]) {
    console.warn(
      `[Gateway] Warning: env var ${p.keyEnvVar} not set — provider "${name}" will be skipped at runtime`,
    );
  }
}

// ---------------------------------------------------------------------------
// Load model metadata (optional — graceful if missing)
// ---------------------------------------------------------------------------

let modelsMeta: Record<string, ModelMeta> = {};
{
  modelsMeta = await readModelsMeta();
  if (Object.keys(modelsMeta).length > 0) {
    console.log(
      `[Gateway] Loaded models-meta.json (${Object.keys(modelsMeta).length} entries)`,
    );
  } else {
    console.warn(
      "[Gateway] models-meta.json not found — run scripts/sync-models.ts to populate it",
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function protocolError(
  protocol: Protocol,
  message: string,
  status: number,
): Response {
  return jsonResponse(
    buildProtocolErrorBody(protocol, { message, status }),
    status,
  );
}

// HTTP statuses that indicate a transient / provider-side issue worth falling back
const FALLBACK_STATUSES = new Set([429, 500, 502, 503, 504]);

// ---------------------------------------------------------------------------
// Model list endpoints
// ---------------------------------------------------------------------------

function getOpenAIModelsList() {
  const data = Object.entries(cfg.models)
    .filter(([, route]) => route.protocols.openai)
    .map(([modelId]) => {
      const meta = modelsMeta[modelId];
      return {
        id: modelId,
        object: "model",
        created: 1715368132,
        owned_by: modelId.split("/")[0],
        ...(meta
          ? {
              context_window: meta.context_window,
              max_output_tokens: meta.max_output_tokens,
              ...(meta.modalities ? { modalities: meta.modalities } : {}),
            }
          : {}),
      };
    });
  return jsonResponse({ object: "list", data }, 200);
}

function buildAnthropicModelInfo(modelId: string) {
  const meta = modelsMeta[modelId];
  return {
    id: modelId,
    type: "model",
    display_name: meta?.name ?? modelId,
    ...(meta
      ? {
          max_input_tokens: meta.context_window,
          max_tokens: meta.max_output_tokens,
        }
      : {}),
  };
}

function getAnthropicModelsList() {
  const data = Object.entries(cfg.models)
    .filter(([, route]) => route.protocols.anthropic)
    .map(([modelId]) => buildAnthropicModelInfo(modelId));
  return jsonResponse(
    {
      data,
      first_id: data[0]?.id ?? null,
      has_more: false,
      last_id: data.at(-1)?.id ?? null,
    },
    200,
  );
}

function getAnthropicModel(modelId: string) {
  const route = cfg.models[modelId];
  if (!route?.protocols.anthropic) {
    return protocolError("anthropic", `Model '${modelId}' not found`, 404);
  }
  return jsonResponse(buildAnthropicModelInfo(modelId), 200);
}

function getGeminiModelsList() {
  const models = Object.entries(cfg.models)
    .filter(([, route]) => route.protocols.gemini)
    .map(([modelId]) => {
      const meta = modelsMeta[modelId];
      return {
        name: `models/${modelId}`,
        baseModelId: modelId,
        version: "001",
        displayName: meta?.name ?? modelId,
        supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
        ...(meta
          ? {
              inputTokenLimit: meta.context_window,
              outputTokenLimit: meta.max_output_tokens,
            }
          : {}),
      };
    });
  return jsonResponse({ models }, 200);
}

// ---------------------------------------------------------------------------
// Generic protocol-aware forwarder
// ---------------------------------------------------------------------------

interface ForwardOptions {
  protocol: Protocol;
  modelName: string;
  method: "GET" | "POST";
  /** Headers from the inbound client request that should be forwarded. */
  forwardHeaders?: Headers;
  /** Raw body (JSON object) — for POSTs that should be re-serialized after remap */
  body?: Record<string, unknown>;
  /**
   * Build the upstream path (relative, no leading slash) given the endpoint
   * and the upstream model name (`remap`). Receives the raw inbound URL so
   * Gemini can preserve `?alt=sse` and other query params.
   */
  buildUpstreamPath: (args: {
    endpoint: ProtocolEndpoint;
    remap: string;
    inboundUrl: URL;
  }) => string;
  /**
   * Optionally transform the JSON body before sending upstream. Default
   * behavior for openai/anthropic is to set `body.model = remap`. Gemini
   * keeps the body verbatim since the model is in the URL path.
   */
  transformBody?: (body: Record<string, unknown>, remap: string) => unknown;
  /** Inbound request URL, used by buildUpstreamPath. */
  inboundUrl: URL;
}

async function forwardToUpstream(opts: ForwardOptions): Promise<Response> {
  const { protocol, modelName, method, body, inboundUrl } = opts;
  const route = cfg.models[modelName];
  if (!route) {
    return protocolError(
      protocol,
      `Model '${modelName}' not found`,
      404,
    );
  }

  const protoRoute = route.protocols[protocol];
  if (!protoRoute || protoRoute.providers.length === 0) {
    return protocolError(
      protocol,
      `Model '${modelName}' is not exposed via ${protocol} protocol`,
      404,
    );
  }

  let candidates = [...protoRoute.providers];
  let lastErrorResponse: Response | null = null;

  while (candidates.length > 0) {
    const selected = candidates[0]!;
    const providerCfg = cfg.providers[selected.name];

    if (!providerCfg) {
      console.warn(
        `[Gateway] Provider "${selected.name}" not defined in config — skipped`,
      );
      candidates = candidates.filter((p) => p.name !== selected.name);
      continue;
    }

    const endpoint = providerCfg.endpoints[protocol];
    if (!endpoint) {
      console.warn(
        `[Gateway] Provider "${selected.name}" has no ${protocol} endpoint — skipped`,
      );
      candidates = candidates.filter((p) => p.name !== selected.name);
      continue;
    }

    const apiKey = process.env[providerCfg.keyEnvVar];
    if (!apiKey) {
      console.warn(
        `[Fallback] Provider "${selected.name}" skipped: env var ${providerCfg.keyEnvVar} not set`,
      );
      candidates = candidates.filter((p) => p.name !== selected.name);
      continue;
    }

    const upstreamPath = opts.buildUpstreamPath({
      endpoint,
      remap: selected.remap,
      inboundUrl,
    });
    const upstreamUrl = `${endpoint.baseUrl.replace(/\/+$/, "")}/${upstreamPath.replace(/^\/+/, "")}`;

    const headers: Record<string, string> = {
      ...buildAuthHeaders(endpoint, protocol, apiKey),
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
    }
    // For Anthropic protocol, propagate the inbound `anthropic-version` header
    // (or set a sensible default) so upstreams that require it succeed.
    if (protocol === "anthropic") {
      const version =
        opts.forwardHeaders?.get("anthropic-version") ?? "2023-06-01";
      headers["anthropic-version"] = version;
      const beta = opts.forwardHeaders?.get("anthropic-beta");
      if (beta) headers["anthropic-beta"] = beta;
    }

    let serializedBody: string | undefined;
    if (method === "POST") {
      const sourceBody = body ?? {};
      const transformed = opts.transformBody
        ? opts.transformBody(sourceBody, selected.remap)
        : { ...sourceBody, model: selected.remap };
      serializedBody = JSON.stringify(transformed);
    }

    try {
      const upstream = await fetch(upstreamUrl, {
        method,
        headers,
        body: serializedBody,
      });

      if (upstream.ok) {
        console.log(
          `[Gateway] → ${protocol}:${selected.name} (${modelName}) — ${upstream.status}`,
        );
        return passThroughResponse(upstream);
      }

      if (FALLBACK_STATUSES.has(upstream.status)) {
        console.warn(
          `[Fallback] Provider "${selected.name}" returned ${upstream.status}, shifting...`,
        );
        lastErrorResponse = passThroughResponse(upstream);
        candidates = candidates.filter((p) => p.name !== selected.name);
        continue;
      }

      return passThroughResponse(upstream);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Fallback] Provider "${selected.name}" unreachable: ${message}`,
      );
      lastErrorResponse = protocolError(
        protocol,
        `Upstream unreachable: ${message}`,
        502,
      );
      candidates = candidates.filter((p) => p.name !== selected.name);
    }
  }

  if (lastErrorResponse) return lastErrorResponse;

  return protocolError(
    protocol,
    `No available providers for model '${modelName}'`,
    502,
  );
}

/**
 * Pass the upstream Response through unchanged. We avoid buffering the body
 * so streaming responses (SSE) remain low-latency.
 */
function passThroughResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

// ---------------------------------------------------------------------------
// Protocol-specific handlers
// ---------------------------------------------------------------------------

async function handleOpenAIChatCompletion(
  req: Request,
  inboundUrl: URL,
): Promise<Response> {
  const body = await readJsonBody(req, "openai");
  if (body instanceof Response) return body;

  const modelName = body.model;
  if (typeof modelName !== "string" || !modelName) {
    return protocolError("openai", "model is required", 400);
  }

  return forwardToUpstream({
    protocol: "openai",
    modelName,
    method: "POST",
    body,
    inboundUrl,
    buildUpstreamPath: () => "chat/completions",
  });
}

async function handleOpenAIImageGeneration(
  req: Request,
  inboundUrl: URL,
): Promise<Response> {
  const body = await readJsonBody(req, "openai");
  if (body instanceof Response) return body;

  const modelName = body.model;
  if (typeof modelName !== "string" || !modelName) {
    return protocolError("openai", "model is required", 400);
  }

  return forwardToUpstream({
    protocol: "openai",
    modelName,
    method: "POST",
    body,
    inboundUrl,
    buildUpstreamPath: () => "images/generations",
  });
}

async function handleAnthropicMessages(
  req: Request,
  inboundUrl: URL,
  endpoint: "messages" | "messages/count_tokens" = "messages",
): Promise<Response> {
  const body = await readJsonBody(req, "anthropic");
  if (body instanceof Response) return body;

  const modelName = body.model;
  if (typeof modelName !== "string" || !modelName) {
    return protocolError("anthropic", "model is required", 400);
  }

  return forwardToUpstream({
    protocol: "anthropic",
    modelName,
    method: "POST",
    body,
    forwardHeaders: req.headers,
    inboundUrl,
    buildUpstreamPath: () => endpoint,
  });
}

async function handleGeminiGenerate(
  req: Request,
  inboundUrl: URL,
  modelAction: string,
): Promise<Response> {
  const { model, action } = parseGeminiModelAction(modelAction);
  if (!model || !action) {
    return protocolError(
      "gemini",
      `Invalid path; expected /v1beta/models/{model}:{action}`,
      400,
    );
  }

  const body = await readJsonBody(req, "gemini");
  if (body instanceof Response) return body;

  return forwardToUpstream({
    protocol: "gemini",
    modelName: model,
    method: "POST",
    body,
    inboundUrl,
    buildUpstreamPath: ({ remap, inboundUrl }) => {
      // We rebuild the query string from inboundUrl, but drop `?key=` since
      // auth is set via header.
      const search = new URLSearchParams(inboundUrl.searchParams);
      search.delete("key");
      const qs = search.toString();
      return `v1beta/models/${encodeURIComponent(remap)}:${action}${qs ? `?${qs}` : ""}`;
    },
    transformBody: (b) => b,
  });
}

function parseGeminiModelAction(raw: string): {
  model: string;
  action: string;
} {
  const decoded = decodeURIComponent(raw);
  const idx = decoded.lastIndexOf(":");
  if (idx === -1) return { model: "", action: "" };
  return {
    model: decoded.slice(0, idx),
    action: decoded.slice(idx + 1),
  };
}

async function readJsonBody(
  req: Request,
  protocol: Protocol,
): Promise<Record<string, unknown> | Response> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return protocolError(protocol, "Invalid JSON body", 400);
  }
}

function stripAnthropicAliasPath(pathname: string): string | null {
  if (pathname === "/anthropic") return "/";
  if (!pathname.startsWith("/anthropic/")) return null;
  return pathname.slice("/anthropic".length);
}

function wantsAnthropicModels(req: Request): boolean {
  return (
    req.headers.has("anthropic-version") ||
    req.headers.has("anthropic-beta") ||
    req.headers.get("x-gateway-protocol") === "anthropic"
  );
}

function inferProtocolFromPath(pathname: string): Protocol {
  if (pathname.startsWith("/v1beta")) return "gemini";
  if (
    pathname === "/anthropic" ||
    pathname.startsWith("/anthropic/") ||
    pathname.startsWith("/v1/messages")
  ) {
    return "anthropic";
  }
  return "openai";
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

function adminJson(body: unknown, status = 200) {
  return jsonResponse(body, status);
}

function adminError(message: string, status = 400) {
  return adminJson({ error: message }, status);
}

function requireAdminAuth(req: Request): Response | null {
  const auth = req.headers.get("Authorization");
  if (auth !== `Bearer ${GATEWAY_KEY}`) {
    return adminError("Invalid gateway API key", 401);
  }

  return null;
}

async function handleAdminRequest(
  req: Request,
  handler: () => Promise<Response> | Response,
): Promise<Response> {
  const authError = requireAdminAuth(req);
  if (authError) return authError;

  try {
    return await handler();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return adminError(message, 500);
  }
}

function getAdminSnapshot() {
  return toAdminConfigSnapshot(cfg, modelsMeta);
}

async function persistAdminConfig(next: AppConfig) {
  cfg = next;
  await writeGatewayConfig(cfg);
  return adminJson(getAdminSnapshot());
}

function parseProtocolParam(value: unknown): Protocol | null {
  if (value === "openai" || value === "anthropic" || value === "gemini") {
    return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  routes: {
    "/admin": adminIndex,
    "/admin/": adminIndex,
    "/admin/api/config": {
      GET: (req) =>
        handleAdminRequest(req, () => adminJson(getAdminSnapshot())),
    },
    "/admin/api/providers/:provider/endpoints/:protocol": {
      PATCH: (req) =>
        handleAdminRequest(req, async () => {
          const { provider } = req.params;
          const protocol = parseProtocolParam(req.params.protocol);
          if (!protocol) return adminError("Invalid protocol");
          const body = (await req.json()) as {
            baseUrl?: string;
            authHeader?: string;
          };
          if (!body.baseUrl) return adminError("baseUrl is required");
          const next = upsertProviderEndpoint(cfg, provider, protocol, {
            baseUrl: body.baseUrl,
            ...(body.authHeader ? { authHeader: body.authHeader } : {}),
          });
          return await persistAdminConfig(next);
        }),
      DELETE: (req) =>
        handleAdminRequest(req, () => {
          const { provider } = req.params;
          const protocol = parseProtocolParam(req.params.protocol);
          if (!protocol) return adminError("Invalid protocol");
          const next = removeProviderEndpoint(cfg, provider, protocol);
          return persistAdminConfig(next);
        }),
    },
    "/admin/api/providers/:provider/models/scan": {
      POST: (req) =>
        handleAdminRequest(req, async () => {
          const { provider } = req.params;
          const body = (await req
            .json()
            .catch(() => ({}))) as { protocol?: string };
          const protocol = parseProtocolParam(body.protocol) ?? "openai";
          const data = await scanProviderModels(cfg, provider, protocol);
          return adminJson({ data, protocol });
        }),
    },
    "/admin/api/models/mappings": {
      POST: (req) =>
        handleAdminRequest(req, async () => {
          const body = (await req.json()) as {
            provider?: string;
            protocol?: string;
            modelIds?: string[];
          };
          if (!body.provider) return adminError("provider is required");
          if (!Array.isArray(body.modelIds))
            return adminError("modelIds is required");
          const protocol = parseProtocolParam(body.protocol) ?? "openai";

          const next = addModelMappings(
            cfg,
            body.provider,
            protocol,
            body.modelIds,
          );
          return await persistAdminConfig(next);
        }),
    },
    "/admin/api/models/:modelId/providers": {
      POST: (req) =>
        handleAdminRequest(req, async () => {
          const body = (await req.json()) as {
            provider?: string;
            protocol?: string;
            remap?: string;
          };
          if (!body.provider) return adminError("provider is required");
          if (!body.remap) return adminError("remap is required");
          const protocol = parseProtocolParam(body.protocol) ?? "openai";

          const modelId = decodeURIComponent(req.params.modelId);
          const next = addModelProviderMapping(
            cfg,
            modelId,
            protocol,
            body.provider,
            body.remap,
          );
          return await persistAdminConfig(next);
        }),
      PATCH: (req) =>
        handleAdminRequest(req, async () => {
          const body = (await req.json()) as {
            protocol?: string;
            providers?: string[];
          };
          if (!Array.isArray(body.providers)) {
            return adminError("providers is required");
          }
          const protocol = parseProtocolParam(body.protocol) ?? "openai";

          const modelId = decodeURIComponent(req.params.modelId);
          const next = reorderModelProviders(
            cfg,
            modelId,
            protocol,
            body.providers,
          );
          return await persistAdminConfig(next);
        }),
      DELETE: (req) =>
        handleAdminRequest(req, async () => {
          const body = (await req.json()) as {
            provider?: string;
            protocol?: string;
          };
          if (!body.provider) return adminError("provider is required");
          const protocol = parseProtocolParam(body.protocol) ?? "openai";

          const modelId = decodeURIComponent(req.params.modelId);
          const next = removeModelProviderMapping(
            cfg,
            modelId,
            protocol,
            body.provider,
          );
          return await persistAdminConfig(next);
        }),
    },
    "/admin/api/client-config": {
      POST: (req) =>
        handleAdminRequest(req, async () => {
          const body = (await req.json()) as {
            kind?:
              | "opencode"
              | "openai-sdk"
              | "curl"
              | "claude-code"
              | "gemini-cli";
            baseUrl?: string;
            apiKeyEnvVar?: string;
            defaultModel?: string;
          };

          const kind = body.kind ?? "opencode";
          const defaultBaseUrl =
            kind === "claude-code"
              ? `http://localhost:${PORT}/anthropic`
              : kind === "gemini-cli"
                ? `http://localhost:${PORT}`
                : `http://localhost:${PORT}/v1`;
          const baseUrl = body.baseUrl ?? defaultBaseUrl;
          const text = generateClientConfig(kind, {
            baseUrl,
            apiKeyEnvVar: body.apiKeyEnvVar,
            defaultModel: body.defaultModel || pickDefaultModel(cfg),
            modelIds: Object.keys(cfg.models),
            modelsMeta,
          });

          return adminJson({ text });
        }),
    },
    "/admin/*": adminIndex,
  },
  async fetch(req) {
    const start = performance.now();
    const url = new URL(req.url);
    const anthropicAliasPath = stripAnthropicAliasPath(url.pathname);

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // Auth
    const auth = req.headers.get("Authorization");
    const xApiKey = req.headers.get("x-api-key");
    const xGoogApiKey = req.headers.get("x-goog-api-key");
    const queryKey = url.searchParams.get("key");

    const presentedKey =
      (auth?.startsWith("Bearer ") ? auth.slice(7) : null) ??
      xApiKey ??
      xGoogApiKey ??
      queryKey;

    let res: Response;
    if (presentedKey !== GATEWAY_KEY) {
      res = protocolError(
        inferProtocolFromPath(url.pathname),
        "Invalid API key",
        401,
      );
    } else if (anthropicAliasPath !== null) {
      if (anthropicAliasPath === "/v1/models" && req.method === "GET") {
        res = getAnthropicModelsList();
      } else if (
        anthropicAliasPath.startsWith("/v1/models/") &&
        req.method === "GET"
      ) {
        const modelId = decodeURIComponent(
          anthropicAliasPath.slice("/v1/models/".length),
        );
        res = getAnthropicModel(modelId);
      } else if (
        anthropicAliasPath === "/v1/messages" &&
        req.method === "POST"
      ) {
        res = await handleAnthropicMessages(req, url, "messages");
      } else if (
        anthropicAliasPath === "/v1/messages/count_tokens" &&
        req.method === "POST"
      ) {
        res = await handleAnthropicMessages(req, url, "messages/count_tokens");
      } else {
        res = protocolError("anthropic", "Not found", 404);
      }
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      res = wantsAnthropicModels(req)
        ? getAnthropicModelsList()
        : getOpenAIModelsList();
    } else if (
      url.pathname === "/v1/chat/completions" &&
      req.method === "POST"
    ) {
      res = await handleOpenAIChatCompletion(req, url);
    } else if (
      url.pathname === "/v1/images/generations" &&
      req.method === "POST"
    ) {
      res = await handleOpenAIImageGeneration(req, url);
    } else if (url.pathname === "/v1/messages" && req.method === "POST") {
      res = await handleAnthropicMessages(req, url, "messages");
    } else if (
      url.pathname === "/v1/messages/count_tokens" &&
      req.method === "POST"
    ) {
      res = await handleAnthropicMessages(req, url, "messages/count_tokens");
    } else if (url.pathname === "/v1beta/models" && req.method === "GET") {
      res = getGeminiModelsList();
    } else if (
      url.pathname.startsWith("/v1beta/models/") &&
      req.method === "POST"
    ) {
      const modelAction = url.pathname.slice("/v1beta/models/".length);
      res = await handleGeminiGenerate(req, url, modelAction);
    } else {
      res = protocolError(
        inferProtocolFromPath(url.pathname),
        "Not found",
        404,
      );
    }

    const elapsed = performance.now() - start;
    console.log(
      `[Gateway] ${req.method} ${url.pathname} → ${res.status} (${elapsed.toFixed(0)}ms)`,
    );
    return res;
  },
});

console.log(`[Gateway] Running on http://localhost:${PORT}`);
