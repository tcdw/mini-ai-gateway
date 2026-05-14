import config from "./config.toml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderConfig {
  baseUrl: string;
  authHeader: string;
  keyEnvVar: string;
}

interface ModelProvider {
  name: string;
  remap: string;
}

interface ModelRoute {
  providers: ModelProvider[];
}

interface AppConfig {
  providers: Record<string, ProviderConfig>;
  models: Record<string, ModelRoute>;
}

interface ModelMeta {
  id: string;
  name: string;
  context_window: number;
  max_output_tokens: number;
}

interface OpenAIError {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

// ---------------------------------------------------------------------------
// Configuration validation
// ---------------------------------------------------------------------------

const GATEWAY_KEY = process.env.GATEWAY_API_KEY;
if (!GATEWAY_KEY) {
  console.error("[Gateway] Fatal: GATEWAY_API_KEY is not set in .env");
  process.exit(1);
}

const PORT = parseInt(process.env.PORT || "3000");
const cfg = config as AppConfig;

// Warn about missing provider keys (non-fatal — will be handled per-request)
for (const [name, p] of Object.entries(cfg.providers)) {
  if (!process.env[p.keyEnvVar]) {
    console.warn(
      `[Gateway] Warning: env var ${p.keyEnvVar} not set — provider "${name}" will be skipped at runtime`
    );
  }
}

// ---------------------------------------------------------------------------
// Load model metadata (optional — graceful if missing)
// ---------------------------------------------------------------------------

let modelsMeta: Record<string, ModelMeta> = {};
{
  const metaFile = Bun.file("./models-meta.json");
  if (await metaFile.exists()) {
    modelsMeta = await metaFile.json();
    console.log(
      `[Gateway] Loaded models-meta.json (${Object.keys(modelsMeta).length} entries)`
    );
  } else {
    console.warn(
      "[Gateway] models-meta.json not found — run scripts/sync-models.ts to populate it"
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: OpenAIError | object, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openAIError(
  message: string,
  type: string,
  code: string | null,
  status: number
) {
  return jsonResponse({ error: { message, type, code } }, status);
}

// HTTP statuses that indicate a transient / provider-side issue worth falling back
const FALLBACK_STATUSES = new Set([429, 500, 502, 503, 504]);

function getModelsList() {
  const data = Object.keys(cfg.models).map((modelId) => {
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
          }
        : {}),
    };
  });
  return jsonResponse({ object: "list", data }, 200);
}

async function handleChatCompletion(req: Request): Promise<Response> {
  // Parse body
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return openAIError("Invalid JSON body", "invalid_request_error", null, 400);
  }

  const modelName = body.model;
  if (typeof modelName !== "string" || !modelName) {
    return openAIError("model is required", "invalid_request_error", null, 400);
  }

  // Look up model route
  const route = cfg.models[modelName];
  if (!route) {
    return openAIError(
      `Model '${modelName}' not found`,
      "model_not_found",
      null,
      404
    );
  }

  // Sequential fallback: try first provider, fallback on 429 etc.
  let candidates = [...route.providers];
  let lastErrorResponse: Response | null = null;

  while (candidates.length > 0) {
    const selected = candidates[0]!;
    const providerCfg = cfg.providers[selected.name];

    if (!providerCfg) {
      console.warn(
        `[Gateway] Provider "${selected.name}" not defined in config — skipped`
      );
      candidates = candidates.filter((p) => p.name !== selected.name);
      continue;
    }

    const apiKey = process.env[providerCfg.keyEnvVar];
    if (!apiKey) {
      console.warn(
        `[Fallback] Provider "${selected.name}" skipped: env var ${providerCfg.keyEnvVar} not set`
      );
      candidates = candidates.filter((p) => p.name !== selected.name);
      continue;
    }

    // Remap model name
    const upstreamBody = { ...body, model: selected.remap };

    try {
      const upstream = await fetch(
        `${providerCfg.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `${providerCfg.authHeader} ${apiKey}`,
          },
          body: JSON.stringify(upstreamBody),
        }
      );

      // Success — stream back to client directly
      if (upstream.ok) {
        console.log(
          `[Gateway] → ${selected.name} (${modelName}) — ${upstream.status}`
        );
        return upstream;
      }

      // Transient upstream failure → try next provider
      if (FALLBACK_STATUSES.has(upstream.status)) {
        console.warn(
          `[Fallback] Provider "${selected.name}" returned ${upstream.status}, shifting...`
        );
        lastErrorResponse = upstream;
        candidates = candidates.filter((p) => p.name !== selected.name);
        continue;
      }

      // Non-transient error (400, 401, 404, etc.) → return directly
      return upstream;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[Fallback] Provider "${selected.name}" unreachable: ${message}`
      );
      lastErrorResponse = openAIError(
        `Upstream unreachable: ${message}`,
        "upstream_error",
        null,
        502
      );
      candidates = candidates.filter((p) => p.name !== selected.name);
    }
  }

  // All candidates exhausted
  if (lastErrorResponse) return lastErrorResponse;

  return openAIError(
    `No available providers for model '${modelName}'`,
    "upstream_error",
    null,
    502
  );
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  async fetch(req) {
    const start = performance.now();
    const url = new URL(req.url);

    // Auth
    const auth = req.headers.get("Authorization");
    let res: Response;
    if (auth !== `Bearer ${GATEWAY_KEY}`) {
      res = openAIError("Invalid API key", "invalid_api_key", null, 401);
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      res = getModelsList();
    } else if (
      url.pathname === "/v1/chat/completions" &&
      req.method === "POST"
    ) {
      res = await handleChatCompletion(req);
    } else {
      res = openAIError("Not found", "not_found", null, 404);
    }

    const elapsed = performance.now() - start;
    console.log(
      `[Gateway] ${req.method} ${url.pathname} → ${res.status} (${elapsed.toFixed(0)}ms)`
    );
    return res;
  },
});

console.log(`[Gateway] Running on http://localhost:${PORT}`);
