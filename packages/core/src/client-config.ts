import type { AppConfig, ModelMeta } from "./types";

export type ClientConfigKind =
  | "opencode"
  | "openai-sdk"
  | "curl"
  | "claude-code"
  | "gemini-cli";

export interface ClientConfigOptions {
  baseUrl: string;
  apiKeyEnvVar?: string;
  defaultModel?: string;
  modelIds?: string[];
  modelsMeta?: Record<string, ModelMeta>;
}

export function pickDefaultModel(cfg: AppConfig): string {
  return Object.keys(cfg.models)[0] ?? "";
}

function rootBaseUrl(baseUrl: string): string {
  // Strip a trailing `/v1` (Anthropic / Gemini SDKs expect the root)
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function anthropicRootBaseUrl(baseUrl: string): string {
  const root = rootBaseUrl(baseUrl);
  return root.endsWith("/anthropic") ? root : `${root}/anthropic`;
}

export function generateClientConfig(
  kind: ClientConfigKind,
  options: ClientConfigOptions,
): string {
  const apiKey = options.apiKeyEnvVar || "GATEWAY_API_KEY";
  const model = options.defaultModel || "openai/gpt-5.5";
  const modelIds = Array.from(new Set([...(options.modelIds ?? []), model]));
  const opencodeModels = Object.fromEntries(
    modelIds.map((modelId) => {
      const meta = options.modelsMeta?.[modelId];
      return [
        modelId,
        {
          name: meta?.name ?? modelId,
          ...(meta?.modalities ? { modalities: meta.modalities } : {}),
        },
      ];
    }),
  );

  if (kind === "opencode") {
    return JSON.stringify(
      {
        provider: {
          "mini-ai-gateway": {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: options.baseUrl,
              apiKey: `{env:${apiKey}}`,
            },
            models: opencodeModels,
          },
        },
        model: `mini-ai-gateway/${model}`,
      },
      null,
      2,
    );
  }

  if (kind === "openai-sdk") {
    return [
      `import OpenAI from "openai";`,
      "",
      `const client = new OpenAI({`,
      `  baseURL: "${options.baseUrl}",`,
      `  apiKey: process.env.${apiKey},`,
      `});`,
      "",
      `const response = await client.chat.completions.create({`,
      `  model: "${model}",`,
      `  messages: [{ role: "user", content: "Hello" }],`,
      `});`,
    ].join("\n");
  }

  if (kind === "claude-code") {
    const root = anthropicRootBaseUrl(options.baseUrl);
    return [
      `# Claude Code → Mini AI Gateway`,
      `# Anthropic SDK expects the protocol root URL (no /v1 suffix).`,
      `export ANTHROPIC_BASE_URL="${root}"`,
      `export ANTHROPIC_AUTH_TOKEN="$${apiKey}"`,
      `# Important: clear ANTHROPIC_API_KEY so Claude Code picks up AUTH_TOKEN.`,
      `export ANTHROPIC_API_KEY=""`,
      `export ANTHROPIC_MODEL="${model}"`,
      "",
      `# Then run:`,
      `#   claude`,
    ].join("\n");
  }

  if (kind === "gemini-cli") {
    const root = rootBaseUrl(options.baseUrl);
    return [
      `# Gemini CLI / @google/genai SDK → Mini AI Gateway`,
      `# Point the SDK base URL at the gateway root; auth is the gateway key.`,
      `export GOOGLE_GEMINI_BASE_URL="${root}"`,
      `export GEMINI_API_KEY="$${apiKey}"`,
      "",
      `# TypeScript:`,
      `#   import { GoogleGenAI } from "@google/genai";`,
      `#   const client = new GoogleGenAI({`,
      `#     apiKey: process.env.GEMINI_API_KEY,`,
      `#     httpOptions: { baseUrl: process.env.GOOGLE_GEMINI_BASE_URL },`,
      `#   });`,
      `#   const result = await client.models.generateContent({`,
      `#     model: "${model}",`,
      `#     contents: "Hello",`,
      `#   });`,
    ].join("\n");
  }

  // curl (default)
  return [
    `curl ${options.baseUrl}/chat/completions \\`,
    `  -H "Authorization: Bearer $${apiKey}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "model": "${model}",`,
    `    "messages": [{ "role": "user", "content": "Hello" }]`,
    `  }'`,
  ].join("\n");
}
