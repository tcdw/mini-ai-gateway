import { expect, test } from "bun:test";
import {
  addModelMappings,
  addModelProviderMapping,
  readGatewayConfig,
  removeModelProviderMapping,
  removeProviderEndpoint,
  reorderModelProviders,
  serializeGatewayConfig,
  toAdminConfigSnapshot,
  upsertProviderEndpoint,
  writeGatewayConfig,
} from "./config";

function tmpPath(prefix: string): string {
  return `${process.env.TMPDIR ?? "/tmp"}/${prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.toml`;
}

function legacyTomlFixture(): string {
  return [
    '[providers."openrouter"]',
    'baseUrl = "https://openrouter.ai/api/v1"',
    'authHeader = "Bearer"',
    'keyEnvVar = "OPENROUTER_API_KEY"',
    "",
    '[[models."openai/gpt-5.5".providers]]',
    'name = "openrouter"',
    'remap = "openai/gpt-5.5"',
    "",
  ].join("\n");
}

function newTomlFixture(): string {
  return [
    '[providers."vercel"]',
    'keyEnvVar = "VERCEL_AI_KEY"',
    "",
    '[providers."vercel".endpoints.openai]',
    'baseUrl = "https://ai-gateway.vercel.sh/v1"',
    "",
    '[providers."vercel".endpoints.anthropic]',
    'baseUrl = "https://ai-gateway.vercel.sh"',
    "",
    '[[models."anthropic/claude-opus-4.7".protocols.openai.providers]]',
    'name = "vercel"',
    'remap = "anthropic/claude-opus-4.7"',
    "",
    '[[models."anthropic/claude-opus-4.7".protocols.anthropic.providers]]',
    'name = "vercel"',
    'remap = "anthropic/claude-opus-4.7"',
    "",
  ].join("\n");
}

async function loadFixture(text: string) {
  const path = tmpPath("cfg");
  await Bun.write(path, text);
  return await readGatewayConfig(path);
}

test("legacy config maps flat providers/models to openai protocol", async () => {
  const cfg = await loadFixture(legacyTomlFixture());
  const provider = cfg.providers.openrouter!;

  expect(provider.endpoints.openai).toEqual({
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Bearer",
  });
  expect(provider.endpoints.anthropic).toBeUndefined();
  expect(provider.keyEnvVar).toBe("OPENROUTER_API_KEY");

  const model = cfg.models["openai/gpt-5.5"]!;
  expect(model.protocols.openai?.providers).toEqual([
    { name: "openrouter", remap: "openai/gpt-5.5" },
  ]);
  expect(model.protocols.anthropic).toBeUndefined();
});

test("new format with explicit endpoints and protocols round-trips", async () => {
  const cfg = await loadFixture(newTomlFixture());
  const provider = cfg.providers.vercel!;

  expect(provider.endpoints.openai?.baseUrl).toBe(
    "https://ai-gateway.vercel.sh/v1",
  );
  expect(provider.endpoints.anthropic?.baseUrl).toBe(
    "https://ai-gateway.vercel.sh",
  );

  const model = cfg.models["anthropic/claude-opus-4.7"]!;
  expect(model.protocols.openai?.providers[0]?.name).toBe("vercel");
  expect(model.protocols.anthropic?.providers[0]?.name).toBe("vercel");

  const path = tmpPath("roundtrip");
  await writeGatewayConfig(cfg, path);
  const cfg2 = await readGatewayConfig(path);
  expect(cfg2).toEqual(cfg);
});

test("addModelMappings appends provider scoped by protocol", async () => {
  const cfg = await loadFixture(newTomlFixture());
  const next = addModelMappings(cfg, "vercel", "anthropic", ["foo/bar"]);

  expect(next.models["foo/bar"]!.protocols.anthropic?.providers).toEqual([
    { name: "vercel", remap: "foo/bar" },
  ]);
  expect(next.models["foo/bar"]!.protocols.openai).toBeUndefined();
});

test("addModelProviderMapping updates remap when provider already present", async () => {
  const cfg = await loadFixture(newTomlFixture());
  const next = addModelProviderMapping(
    cfg,
    "anthropic/claude-opus-4.7",
    "anthropic",
    "vercel",
    "claude-opus-newer",
  );

  expect(
    next.models["anthropic/claude-opus-4.7"]!.protocols.anthropic?.providers[0],
  ).toEqual({ name: "vercel", remap: "claude-opus-newer" });
});

test("removeModelProviderMapping prunes empty protocol/model entries", async () => {
  const cfg = await loadFixture(newTomlFixture());
  const afterRemoveAnthropic = removeModelProviderMapping(
    cfg,
    "anthropic/claude-opus-4.7",
    "anthropic",
    "vercel",
  );
  expect(
    afterRemoveAnthropic.models["anthropic/claude-opus-4.7"]!.protocols
      .anthropic,
  ).toBeUndefined();

  const afterRemoveAll = removeModelProviderMapping(
    afterRemoveAnthropic,
    "anthropic/claude-opus-4.7",
    "openai",
    "vercel",
  );
  expect(afterRemoveAll.models["anthropic/claude-opus-4.7"]).toBeUndefined();
});

test("reorderModelProviders reorders providers within a protocol", async () => {
  const cfg = await loadFixture(newTomlFixture());
  const seeded = addModelProviderMapping(
    cfg,
    "anthropic/claude-opus-4.7",
    "openai",
    "openrouter",
    "anthropic/claude-opus-4.7",
  );
  const reordered = reorderModelProviders(
    seeded,
    "anthropic/claude-opus-4.7",
    "openai",
    ["openrouter", "vercel"],
  );

  expect(
    reordered.models["anthropic/claude-opus-4.7"]!.protocols.openai?.providers.map(
      (p) => p.name,
    ),
  ).toEqual(["openrouter", "vercel"]);
});

test("upsert / remove provider endpoint", async () => {
  const cfg = await loadFixture(newTomlFixture());
  const withGemini = upsertProviderEndpoint(cfg, "vercel", "gemini", {
    baseUrl: "https://example.com",
    authHeader: "x-goog-api-key",
  });
  expect(withGemini.providers.vercel!.endpoints.gemini).toEqual({
    baseUrl: "https://example.com",
    authHeader: "x-goog-api-key",
  });

  const removed = removeProviderEndpoint(withGemini, "vercel", "gemini");
  expect(removed.providers.vercel!.endpoints.gemini).toBeUndefined();
});

test("toAdminConfigSnapshot exposes endpoints and protocol routes", async () => {
  const cfg = await loadFixture(newTomlFixture());
  const snapshot = toAdminConfigSnapshot(
    cfg,
    {},
    { VERCEL_AI_KEY: "sk-test" },
  );

  const provider = snapshot.providers.find((p) => p.name === "vercel");
  expect(provider?.hasApiKey).toBe(true);
  expect(provider?.endpoints.openai?.baseUrl).toBe(
    "https://ai-gateway.vercel.sh/v1",
  );
  expect(provider?.endpoints.anthropic?.baseUrl).toBe(
    "https://ai-gateway.vercel.sh",
  );

  const model = snapshot.models.find(
    (m) => m.id === "anthropic/claude-opus-4.7",
  );
  expect(model?.protocols.openai?.providers[0]?.name).toBe("vercel");
  expect(model?.protocols.anthropic?.providers[0]?.name).toBe("vercel");
});

test("buildAuthHeaders chooses sensible defaults per protocol", async () => {
  const { buildAuthHeaders } = await import("./protocol");

  expect(buildAuthHeaders({ baseUrl: "x" }, "openai", "k")).toEqual({
    Authorization: "Bearer k",
  });
  expect(buildAuthHeaders({ baseUrl: "x" }, "anthropic", "k")).toEqual({
    Authorization: "Bearer k",
  });
  expect(buildAuthHeaders({ baseUrl: "x" }, "gemini", "k")).toEqual({
    "x-goog-api-key": "k",
  });
  expect(
    buildAuthHeaders({ baseUrl: "x", authHeader: "x-api-key" }, "anthropic", "k"),
  ).toEqual({ "x-api-key": "k" });
  expect(
    buildAuthHeaders({ baseUrl: "x", authHeader: "Bearer" }, "openai", "k"),
  ).toEqual({ Authorization: "Bearer k" });
});

test("buildProtocolErrorBody returns dialect-appropriate shapes", async () => {
  const { buildProtocolErrorBody } = await import("./protocol");

  expect(
    buildProtocolErrorBody("openai", { message: "boom", status: 502 }),
  ).toEqual({
    error: { message: "boom", type: "upstream_error", code: null },
  });
  expect(
    buildProtocolErrorBody("anthropic", { message: "boom", status: 502 }),
  ).toEqual({
    type: "error",
    error: { type: "api_error", message: "boom" },
  });
  expect(
    buildProtocolErrorBody("gemini", { message: "boom", status: 503 }),
  ).toEqual({
    error: { code: 503, message: "boom", status: "UNAVAILABLE" },
  });
});
