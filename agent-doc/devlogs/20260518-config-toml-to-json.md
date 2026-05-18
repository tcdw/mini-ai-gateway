## 背景

`config.toml` 长期承担 provider 与 model 路由表的真值来源。多协议结构铺开后，路由表迅速膨胀：每个 model × 每种协议 × 每个 provider 都需要一段 `[[models."xxx".protocols.yyy.providers]]` 的 array-of-tables 表头，重复的引号、点号和空行让手动维护越来越累；同时 `packages/core/src/config.ts` 还得维护一套自己的 TOML 序列化器（`escapeTomlKey` / `escapeTomlValue` + 行拼接），增加了维护面与 round-trip 风险。

`scripts/scan-models.ts` 是另一处历史包袱：

- 它通过 `import config from "../config.toml"` 直接读取，绕过了 `packages/core` 的归一化逻辑；
- 类型用的是旧的 flat `ProviderConfig`（`baseUrl` / `authHeader` 直接挂在 provider 上），与多协议改造后的新 schema 已经对不上；
- 它自带一段独立的 TOML 拼接代码用于追加 mapping。

本次改造的目标：将真值文件从 TOML 切换为 JSON，并顺手把 `scan-models` 收敛到 core 包的公共配置 API 上。

## 主要变更

### 1. 真值文件迁移到 `config.json`

新建 `config.json`，把原有 6 个 provider、18 个 model 路由原样搬过来，结构与新 schema 完全一致（providers.endpoints.<protocol>.baseUrl + models.<id>.protocols.<protocol>.providers[]）：

```json
{
  "providers": {
    "vercel": {
      "keyEnvVar": "VERCEL_AI_KEY",
      "endpoints": {
        "openai": { "baseUrl": "https://ai-gateway.vercel.sh/v1" },
        "anthropic": { "baseUrl": "https://ai-gateway.vercel.sh/v1" }
      }
    }
  },
  "models": {
    "anthropic/claude-opus-4.7": {
      "protocols": {
        "openai":    { "providers": [ { "name": "openrouter", "remap": "anthropic/claude-opus-4.7" } ] },
        "anthropic": { "providers": [ { "name": "openrouter", "remap": "anthropic/claude-opus-4.7" } ] }
      }
    }
  }
}
```

同时删除 `config.toml`。

### 2. `packages/core/src/config.ts` 改用 `Bun.file().json()` + `JSON.stringify`

`readGatewayConfig` 默认路径切换为 `./config.json`，读取改用原生 JSON parser；`normalizeConfig` 及 legacy 兼容层（flat `baseUrl` / flat `providers[]` → openai 协议）保持不变，老格式仍能被吃下来：

```ts
export async function readGatewayConfig(
  configPath = "./config.json",
): Promise<AppConfig> {
  const raw = await Bun.file(configPath).json();
  return normalizeConfig(raw);
}
```

序列化函数整个推倒，原来近 40 行的 TOML 行拼接被替换为一段 canonical 重组 + 一次 `JSON.stringify`，仍然保证：

- protocol 顺序按 `PROTOCOLS` 常量稳定排列；
- 空 `endpoints` / 空 `protocols` 被自然省略；
- `authHeader` 只在存在时序列化。

```ts
return `${JSON.stringify({ providers, models }, null, 2)}\n`;
```

参考：`packages/core/src/config.ts:90`、`packages/core/src/config.ts:105`、`packages/core/src/config.ts:141`。

### 3. `config.test.ts` fixture 换成 JSON

`tmpPath` 后缀改成 `.json`，`legacyTomlFixture` / `newTomlFixture` 重命名为 `legacyJsonFixture` / `newJsonFixture` 并改用 `JSON.stringify` 构造：

```ts
function newJsonFixture(): string {
  return JSON.stringify({
    providers: {
      vercel: {
        keyEnvVar: "VERCEL_AI_KEY",
        endpoints: {
          openai: { baseUrl: "https://ai-gateway.vercel.sh/v1" },
          anthropic: { baseUrl: "https://ai-gateway.vercel.sh" },
        },
      },
    },
    models: {
      "anthropic/claude-opus-4.7": {
        protocols: {
          openai:    { providers: [{ name: "vercel", remap: "anthropic/claude-opus-4.7" }] },
          anthropic: { providers: [{ name: "vercel", remap: "anthropic/claude-opus-4.7" }] },
        },
      },
    },
  });
}
```

round-trip 测试（`writeGatewayConfig` → `readGatewayConfig` → 结构相等）保留，验证新 JSON 序列化器的稳定性。

### 4. `scripts/scan-models.ts` 收敛到 core 包

旧脚本走的是 `import config from "../config.toml"` + 内置 TOML 拼接，类型与新 schema 已经不兼容。这次直接换成 workspace package 公开的 API：

```ts
import {
  addModelProviderMapping,
  readGatewayConfig,
  readModelsMeta,
  writeGatewayConfig,
  type AppConfig,
  type Protocol,
  type ProtocolEndpoint,
} from "@mini-ai-gateway/core";
```

附带修掉一个隐藏 bug：原脚本拿 `providerCfg.baseUrl` / `providerCfg.authHeader` 调用 `/models`，这些字段在新 schema 下其实位于 `endpoints.openai.*`，老脚本对新格式直接就会拿到 `undefined`。现在显式从 openai endpoint 取：

```ts
const providerCfg = cfg.providers[selectedProvider]!;
const openaiEndpoint = providerCfg.endpoints.openai;
if (!openaiEndpoint) {
  console.error(
    `Provider "${selectedProvider}" has no OpenAI-compatible endpoint configured.`,
  );
  process.exit(1);
}
```

写入阶段也不再手拼字符串，而是循环调用 `addModelProviderMapping` 累积出新 config，再交给 `writeGatewayConfig` 落盘：

```ts
let nextCfg: AppConfig = cfg;
const protocol: Protocol = "openai";
for (const modelId of toAdd) {
  nextCfg = addModelProviderMapping(
    nextCfg, modelId, protocol, selectedProvider, modelId,
  );
}
await writeGatewayConfig(nextCfg, CONFIG_PATH);
```

"已配置"检测也从只看 flat `route.providers` 升级为只检查 `route.protocols.openai.providers`，与脚本默认写入 `openai` 协议的行为对齐。

参考：`scripts/scan-models.ts:1`、`scripts/scan-models.ts:228`、`scripts/scan-models.ts:373`。

### 5. README 示例更新

`README.md:70` 一段从 TOML 片段改成等价的 JSON 片段，避免新读者照着复制还在写 array-of-tables。

## 验证

```bash
bun test
# 12 pass / 0 fail / 36 expect() calls

bunx tsc --noEmit
# clean
```

`bun test` 覆盖 legacy 兼容、新格式 round-trip、`addModelMappings` / `addModelProviderMapping` / `removeModelProviderMapping` / `reorderModelProviders` / `upsert/removeProviderEndpoint` / `toAdminConfigSnapshot`，全部通过；`tsc --noEmit` 在 workspace 全量类型检查下无输出。

## 提交

```txt
90a795a refactor: migrate config from TOML to JSON
```
