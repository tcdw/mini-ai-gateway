import config from "../config.toml";
import { search, confirm } from "@inquirer/prompts";

// ---------------------------------------------------------------------------
// Types (mirror index.ts)
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

interface AppConfig {
  providers: Record<string, ProviderConfig>;
  models: Record<string, { providers: ModelProvider[] }>;
}

interface ModelMeta {
  id: string;
  name: string;
  context_window: number;
  max_output_tokens: number;
}

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

function escapeTomlKey(key: string): string {
  return key.includes('"') ? `"${key.replace(/"/g, '\\"')}"` : `"${key}"`;
}

function escapeTomlValue(val: string): string {
  return val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

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

async function main() {
  if (!process.stdin.isTTY) {
    console.error("This script requires an interactive terminal (TTY).");
    process.exit(1);
  }

  const cfg = config as AppConfig;

  // ------------------------------------------------------------------
  // Step 1: Select a provider
  // ------------------------------------------------------------------
  const providerNames = Object.keys(cfg.providers).sort();
  if (providerNames.length === 0) {
    console.log("No providers found in config.toml");
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

  // ------------------------------------------------------------------
  // Step 2: Fetch models from the provider's /v1/models endpoint
  // ------------------------------------------------------------------
  const apiKey = process.env[providerCfg.keyEnvVar];
  if (!apiKey) {
    console.log(
      `\n⚠  env var ${providerCfg.keyEnvVar} is not set — trying without auth...\n`
    );
  }

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `${providerCfg.authHeader} ${apiKey}`;
  }

  process.stdout.write(`Fetching models from ${providerCfg.baseUrl}/models ...`);

  let models: ProviderModel[] = [];
  try {
    const res = await fetch(`${providerCfg.baseUrl}/models`, { headers });

    if (!res.ok) {
      console.log(`\nFailed: HTTP ${res.status} ${res.statusText}`);
      const body = await res.text();
      console.error(body.slice(0, 500));
      process.exit(1);
    }

    const data = (await res.json()) as ModelsListResponse;
    if (!data.data || !Array.isArray(data.data)) {
      console.log("\nUnexpected response format from /v1/models");
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
  let metaDb: Record<string, ModelMeta> = {};
  const metaFile = Bun.file("./models-meta.json");
  if (await metaFile.exists()) {
    metaDb = await metaFile.json();
  }

  // ------------------------------------------------------------------
  // Step 4: Build TUI choices (detect already-configured models)
  // ------------------------------------------------------------------

  const configuredProviderModels = new Set<string>();
  for (const [modelId, route] of Object.entries(cfg.models)) {
    for (const p of route.providers) {
      if (p.name === selectedProvider) {
        configuredProviderModels.add(modelId);
        break;
      }
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

  // Filter out any that are already fully configured (shouldn't happen
  // since they're disabled, but guard anyway)
  const toAdd = selectedModels.filter(
    (id) => !configuredProviderModels.has(id)
  );

  if (toAdd.length === 0) {
    console.log("All selected models are already configured. Nothing to do.");
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Step 6: Generate TOML blocks
  // ------------------------------------------------------------------
  let tomlBlocks = "";
  for (const modelId of toAdd) {
    const key = escapeTomlKey(modelId);
    const name = escapeTomlValue(selectedProvider);
    const remap = escapeTomlValue(modelId);
    tomlBlocks += `\n[[models.${key}.providers]]\nname = "${name}"\nremap = "${remap}"\n`;
  }

  // ------------------------------------------------------------------
  // Step 7: Preview & confirm
  // ------------------------------------------------------------------
  console.log("\n─── Preview ───");
  console.log(tomlBlocks.trimEnd());
  console.log("────────────────\n");

  const ok = await confirm({
    message: `Write ${toAdd.length} model(s) to config.toml?`,
    default: false,
  });

  if (!ok) {
    console.log("Cancelled.");
    process.exit(0);
  }

  // ------------------------------------------------------------------
  // Step 8: Append to config.toml
  // ------------------------------------------------------------------
  const configPath = "./config.toml";
  const existingContent = await Bun.file(configPath).text();
  await Bun.write(configPath, existingContent + tomlBlocks);
  console.log(`✓ Added ${toAdd.length} model(s) to config.toml`);
}

main();
