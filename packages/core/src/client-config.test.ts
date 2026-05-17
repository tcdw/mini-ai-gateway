import { expect, test } from "bun:test";
import { generateClientConfig } from "./client-config";

test("opencode config declares all configured models with modalities metadata", () => {
  const text = generateClientConfig("opencode", {
    baseUrl: "http://localhost:3000/v1",
    apiKeyEnvVar: "GATEWAY_API_KEY",
    defaultModel: "openai/gpt-5.5",
    modelIds: ["openai/gpt-5.5", "google/gemini-3.1-pro-preview"],
    modelsMeta: {
      "openai/gpt-5.5": {
        id: "openai/gpt-5.5",
        name: "OpenAI: GPT-5.5",
        context_window: 1050000,
        max_output_tokens: 128000,
        modalities: {
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
      },
      "google/gemini-3.1-pro-preview": {
        id: "google/gemini-3.1-pro-preview",
        name: "Google: Gemini 3.1 Pro Preview",
        context_window: 1048576,
        max_output_tokens: 65536,
        modalities: {
          input: ["audio", "image", "pdf", "text", "video"],
          output: ["text"],
        },
      },
    },
  });

  const parsed = JSON.parse(text);

  expect(parsed.model).toBe("mini-ai-gateway/openai/gpt-5.5");
  expect(
    parsed.provider["mini-ai-gateway"].models["openai/gpt-5.5"].modalities
  ).toEqual({
    input: ["text", "image", "pdf"],
    output: ["text"],
  });
  expect(
    parsed.provider["mini-ai-gateway"].models[
      "google/gemini-3.1-pro-preview"
    ].modalities
  ).toEqual({
    input: ["audio", "image", "pdf", "text", "video"],
    output: ["text"],
  });
});
