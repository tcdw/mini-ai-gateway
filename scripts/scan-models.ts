import { search, confirm } from "@inquirer/prompts";
import {
  addModelProviderMapping,
  readGatewayConfig,
  readModelsMeta,
  writeGatewayConfig,
  type AppConfig,
  type Protocol,
  type ProtocolEndpoint,
} from "@mini-ai-gateway/core";

// ---------------------------------------------------------------------------
// Types (local helpers only — main types come from packages/core)
// ---------------------------------------------------------------------------

interface ProviderModel {
  id: string;
  owned_by?: string;
}

interface ModelsListResponse {
  data: ProviderModel[];
}

interface ModelChoice {
  name: string;
  value: string;
  checked: boolean;
  disabled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatContext(ctx: number | undefined): string {
  if (!ctx) return "";
  return ctx >= 1000
    ? `  [${(ctx / 1000).toFixed(0)}k ctx]`
    : `  [${ctx} ctx]`;
}

function filterChoices(choices: ModelChoice[], query: string): ModelChoice[] {
  const term = query.trim().toLowerCase();
  if (!term) return choices;
  return choices.filter(
    (choice) =>
      choice.value.toLowerCase().includes(term) ||
      choice.name.toLowerCase().includes(term)
  );
}

function truncateLine(line: string, width: number): string {
  if (line.length <= width) return line;
  return `${line.slice(0, Math.max(0, width - 1))}…`;
}

function buildAuthHeader(endpoint: ProtocolEndpoint, apiKey: string): Record<string, string> {
  const headerName = endpoint.authHeader ?? "Bearer";
  if (headerName.toLowerCase() === "bearer") {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return { [headerName]: apiKey };
}

async function selectModelsTui(
  message: string,
  choices: ModelChoice[]
): Promise<string[]> {
  const selected = new Set(
    choices.filter((choice) => choice.checked).map((choice) => choice.value)
  );

  let query = "";
  let cursor = 0;
  let scroll = 0;
  let done = false;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRawMode = stdin.isRaw;

  function render() {
    const filtered = filterChoices(choices, query);
    if (cursor >= filtered.length) cursor = Math.max(0, filtered.length - 1);
    if (cursor < 0) cursor = 0;

    const rows = stdout.rows || 24;
    const columns = stdout.columns || 100;
    const pageSize = Math.max(5, rows - 8);

    if (cursor < scroll) scroll = cursor;
    if (cursor >= scroll + pageSize) scroll = cursor - pageSize + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, filtered.length - pageSize)));

    const visible = filtered.slice(scroll, scroll + pageSize);
    const totalSelectable = choices.filter((choice) => !choice.disabled).length;

    stdout.write("\x1b[2J\x1b[H");
    stdout.write(`? ${message}\n`);
    stdout.write(`Search: ${query}\x1b[7m \x1b[0m\n`);
    stdout.write(
      `${selected.size}/${totalSelectable} selected · ${filtered.length}/${choices.length} visible\n\n`
    );

    if (visible.length === 0) {
      stdout.write("  No models match your search.\n");
    } else {
      for (let i = 0; i < visible.length; i++) {
        const choice = visible[i]!;
        const index = scroll + i;
        const active = index === cursor;
        const marker = active ? "›" : " ";
        const checked = selected.has(choice.value) || choice.disabled;
        const box = checked ? "●" : "○";
        const color = choice.disabled ? "\x1b[90m" : active ? "\x1b[36m" : "";
        const reset = color ? "\x1b[0m" : "";
        const line = truncateLine(`${marker}${box} ${choice.name}`, columns);
        stdout.write(`${color}${line}${reset}\n`);
      }
    }

    stdout.write(
      `\n↑↓ navigate · type search · backspace delete · space select · ctrl+a toggle filtered · enter submit · esc cancel`
    );
  }

  function cleanup() {
    stdin.off("data", onData);
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(previousRawMode ?? false);
    stdout.write("\x1b[?25h\x1b[?1049l");
  }

  function toggleCurrent() {
    const filtered = filterChoices(choices, query);
    const choice = filtered[cursor];
    if (!choice || choice.disabled) return;
    if (selected.has(choice.value)) selected.delete(choice.value);
    else selected.add(choice.value);
  }

  function toggleFiltered() {
    const filtered = filterChoices(choices, query).filter((choice) => !choice.disabled);
    if (filtered.length === 0) return;
    const allSelected = filtered.every((choice) => selected.has(choice.value));
    for (const choice of filtered) {
      if (allSelected) selected.delete(choice.value);
      else selected.add(choice.value);
    }
  }

  return await new Promise<string[]>((resolve) => {
    function finish(values: string[]) {
      if (done) return;
      done = true;
      cleanup();
      resolve(values);
    }

    onData = (chunk: string) => {
      if (chunk === "\u0003") {
        cleanup();
        process.exit(130);
      }

      if (chunk === "\u001b") {
        finish([]);
        return;
      }

      if (chunk === "\r" || chunk === "\n") {
        finish([...selected]);
        return;
      }

      if (chunk === "\u001b[A") cursor--;
      else if (chunk === "\u001b[B") cursor++;
      else if (chunk === " ") toggleCurrent();
      else if (chunk === "\u0001") toggleFiltered();
      else if (chunk === "\u007f" || chunk === "\b") {
        query = query.slice(0, -1);
        cursor = 0;
        scroll = 0;
      } else if (chunk === "\u0015") {
        query = "";
        cursor = 0;
        scroll = 0;
      } else if (chunk.length === 1 && chunk >= " " && chunk !== "\u007f") {
        query += chunk;
        cursor = 0;
        scroll = 0;
      }

      render();
    };

    stdout.write("\x1b[?1049h\x1b[?25l");
    if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    render();
  });
}

let onData: (chunk: string) => void;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CONFIG_PATH = "./config.json";

async function main() {
  if (!process.stdin.isTTY) {
    console.error("This script requires an interactive terminal (TTY).");
    process.exit(1);
  }

  const cfg: AppConfig = await readGatewayConfig(CONFIG_PATH);

  // ------------------------------------------------------------------
  // Step 1: Select a provider
  // ------------------------------------------------------------------
  const providerNames = Object.keys(cfg.providers).sort();
  if (providerNames.length === 0) {
    console.log(`No providers found in ${CONFIG_PATH}`);
    process.exit(1);
  }

  const selectedProvider = await search({
    message: "Select a provider to scan",
    source: async (input) => {
      const term = (input || "").toLowerCase();
      const filtered = providerNames.filter((n) =>
        n.toLowerCase().includes(term)
      );
      return filtered.map((name) => ({ name, value: name }));
    },
  });

  const providerCfg = cfg.providers[selectedProvider]!;
  const openaiEndpoint = providerCfg.endpoints.openai;
  if (!openaiEndpoint) {
    console.error(
      `Provider "${selectedProvider}" has no OpenAI-compatible endpoint configured.`
    );
    process.exit(1);
  }

  // ------------------------------------------------------------------
  // Step 2: Fetch models from the provider's /models endpoint
  // ------------------------------------------------------------------
  const apiKey = process.env[providerCfg.keyEnvVar];
  if (!apiKey) {
    console.log(
      `\n⚠  env var ${providerCfg.keyEnvVar} is not set — trying without auth...\n`
    );
  }

  const headers: Record<string, string> = apiKey
    ? buildAuthHeader(openaiEndpoint, apiKey)
    : {};

  process.stdout.write(
    `Fetching models from ${openaiEndpoint.baseUrl}/models ...`
  );

  let models: ProviderModel[] = [];
  try {
    const res = await fetch(`${openaiEndpoint.baseUrl}/models`, { headers });

    if (!res.ok) {
      console.log(`\nFailed: HTTP ${res.status} ${res.statusText}`);
      const body = await res.text();
      console.error(body.slice(0, 500));
      process.exit(1);
    }

    const data = (await res.json()) as ModelsListResponse;
    if (!data.data || !Array.isArray(data.data)) {
      console.log("\nUnexpected response format from /models");
      console.error(JSON.stringify(data).slice(0, 500));
      process.exit(1);
    }
    models = data.data;
    console.log(` ${models.length} models found`);
  } catch (err) {
    console.log(
      `\nNetwork error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exit(1);
  }

  if (models.length === 0) {
    console.log("No models returned from this provider.");
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Step 3: Load models-meta.json for context window metadata
  // ------------------------------------------------------------------
  const metaDb = await readModelsMeta();

  // ------------------------------------------------------------------
  // Step 4: Build TUI choices (detect already-configured models on openai protocol)
  // ------------------------------------------------------------------

  const configuredProviderModels = new Set<string>();
  for (const [modelId, route] of Object.entries(cfg.models)) {
    const openaiRoute = route.protocols.openai;
    if (!openaiRoute) continue;
    if (openaiRoute.providers.some((p) => p.name === selectedProvider)) {
      configuredProviderModels.add(modelId);
    }
  }

  // Sort: unconfigured first, then configured. Within each group, alphabetical.
  const sortedModels = [...models].sort((a, b) => {
    const aCfg = configuredProviderModels.has(a.id) ? 1 : 0;
    const bCfg = configuredProviderModels.has(b.id) ? 1 : 0;
    if (aCfg !== bCfg) return aCfg - bCfg;
    return a.id.localeCompare(b.id);
  });

  const choices: ModelChoice[] = sortedModels.map((m) => {
    const meta = metaDb[m.id];
    const alreadyConfigured = configuredProviderModels.has(m.id);
    const marker = alreadyConfigured ? "✓ " : "";
    const suffix = alreadyConfigured ? " (already configured)" : "";
    const ctxStr = formatContext(meta?.context_window);

    return {
      name: `${marker}${m.id}${ctxStr}${suffix}`,
      value: m.id,
      checked: false,
      disabled: alreadyConfigured,
    };
  });

  const newCount = choices.filter((c) => !c.disabled).length;
  const existingCount = choices.length - newCount;
  console.log(
    `\n${newCount} new model(s), ${existingCount} already configured\n`
  );

  // ------------------------------------------------------------------
  // Step 5: Interactive model selection (searchable TUI)
  // ------------------------------------------------------------------
  const selectedModels = await selectModelsTui(
    `Select models from "${selectedProvider}"`,
    choices
  );

  if (selectedModels.length === 0) {
    console.log("No models selected. Exiting.");
    process.exit(0);
  }

  const toAdd = selectedModels.filter(
    (id) => !configuredProviderModels.has(id)
  );

  if (toAdd.length === 0) {
    console.log("All selected models are already configured. Nothing to do.");
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Step 6: Preview & confirm
  // ------------------------------------------------------------------
  console.log("\n─── Preview ───");
  for (const modelId of toAdd) {
    console.log(`  + ${modelId}  ←  ${selectedProvider} (openai)`);
  }
  console.log("────────────────\n");

  const ok = await confirm({
    message: `Write ${toAdd.length} model(s) to ${CONFIG_PATH}?`,
    default: false,
  });

  if (!ok) {
    console.log("Cancelled.");
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Step 7: Write to config.json via the core helpers
  // ------------------------------------------------------------------
  let nextCfg: AppConfig = cfg;
  const protocol: Protocol = "openai";
  for (const modelId of toAdd) {
    nextCfg = addModelProviderMapping(
      nextCfg,
      modelId,
      protocol,
      selectedProvider,
      modelId,
    );
  }

  await writeGatewayConfig(nextCfg, CONFIG_PATH);
  console.log(`✓ Added ${toAdd.length} model(s) to ${CONFIG_PATH}`);
}

main();
