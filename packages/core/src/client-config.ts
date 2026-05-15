import type { AppConfig } from "./types";

export type ClientConfigKind = "opencode" | "openai-sdk" | "curl";

export interface ClientConfigOptions {
  baseUrl: string;
  apiKeyEnvVar?: string;
  defaultModel?: string;
}

export function pickDefaultModel(cfg: AppConfig): string {
  return Object.keys(cfg.models)[0] ?? "";
}

export function generateClientConfig(
  kind: ClientConfigKind,
  options: ClientConfigOptions
): string {
  const apiKey = options.apiKeyEnvVar || "GATEWAY_API_KEY";
  const model = options.defaultModel || "openai/gpt-5.5";

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
            models: {
              [model]: {},
            },
          },
        },
        model: `mini-ai-gateway/${model}`,
      },
      null,
      2
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
