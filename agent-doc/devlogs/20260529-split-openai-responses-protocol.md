# AI Gateway - 20260529 拆分 OpenAI Responses 为独立协议开发日志

## 背景

同日早些时候（devlog `20260529-openai-official-responses.md`，commit `854e4f4`）接入了 `/v1/responses`，但当时把它直接挂在了 `openai` 协议下：handler 用 `protocol: "openai"`，路由读取的是 `protocols.openai.providers`。

这有一个本质问题：**OpenAI Chat Completions 与 Responses 是两套不同的 API。**

- `openai`（Chat Completions）被大量第三方源兼容（OpenRouter / Vercel / AIHubMix / DeepSeek …）。
- `openai-responses`（Responses API）是 OpenAI 独家，携带加密的上下文信息，第三方 OpenAI-compatible 源并不支持。

把 Responses 挂在 `openai` 协议下，意味着 `/v1/responses` 会沿用 `openai` 的 provider 链，对 429 / 5xx 时还会 fallback 到 openrouter / vercel 这类**根本不支持 Responses 的源**，行为不正确。

本次按照 Gemini 的处理方式，把 Responses 提升为一个**独立协议** `openai-responses`，拥有自己的 provider 链、endpoint 和 fallback 边界，与 `openai` 互不串台。

## 主要变更

### 1. 协议枚举新增 `openai-responses`

`packages/core/src/types.ts:1` 扩展 `Protocol` 联合类型与 `PROTOCOLS` 数组（顺序紧跟 `openai`）：

```ts
export type Protocol = "openai" | "openai-responses" | "anthropic" | "gemini";

export const PROTOCOLS: readonly Protocol[] = [
  "openai",
  "openai-responses",
  "anthropic",
  "gemini",
] as const;
```

`buildAuthHeaders` / `buildProtocolErrorBody`（`packages/core/src/protocol.ts`）无需改动：前者非 `gemini` 默认即 `Bearer`，后者非 anthropic / gemini 走 OpenAI 错误格式（else 分支），`openai-responses` 天然复用。

### 2. `handleOpenAIResponses` 改用新协议

`index.ts` 把 handler 的协议从 `openai` 改为 `openai-responses`，上游路径仍是 `responses`：

```ts
return forwardToUpstream({
  protocol: "openai-responses",
  modelName,
  method: "POST",
  body,
  inboundUrl,
  buildUpstreamPath: () => "responses",
});
```

于是 `/v1/responses` 只会读取 `protocols["openai-responses"].providers`，与 Chat Completions 的 provider 链彻底隔离。

### 3. 路由与 admin 协议解析放开新协议

- `index.ts` `inferProtocolFromPath` 对 `/v1/responses` 显式返回 `openai-responses`（错误格式仍是 OpenAI 风格）。
- `index.ts` `parseProtocolParam` 接受 `"openai-responses"`，使 admin API 能管理该协议的 endpoint / provider 链。

### 4. config.json：provider endpoint 与模型 provider 链分流

`openai-official` 新增 `openai-responses` endpoint（baseUrl 与 `openai` 同源，仅路径不同）：

```json
"openai-official": {
  "keyEnvVar": "OPENAI_API_KEY",
  "endpoints": {
    "openai": { "baseUrl": "https://api.openai.com/v1" },
    "openai-responses": { "baseUrl": "https://api.openai.com/v1" }
  }
}
```

`openai/gpt-5.5` 拆出独立的 `openai-responses` 协议块，只挂官方源；`openai`（Chat Completions）块保留第三方源做 fallback：

```json
"openai/gpt-5.5": {
  "protocols": {
    "openai": {
      "providers": [
        { "name": "openai-official", "remap": "gpt-5.5" },
        { "name": "openrouter", "remap": "openai/gpt-5.5" },
        { "name": "vercel", "remap": "openai/gpt-5.5" },
        { "name": "aihubmix", "remap": "gpt-5.5" }
      ]
    },
    "openai-responses": {
      "providers": [
        { "name": "openai-official", "remap": "gpt-5.5" }
      ]
    }
  }
}
```

### 5. Admin 前端同步新协议

- `apps/admin/src/helpers/config-helpers.ts`：`PROTOCOLS` / `PROTOCOL_LABELS`（`"OpenAI Responses"`）/ `PROTOCOL_COLORS`（`cyan`）补齐 `openai-responses`。
- `apps/admin/src/routes/providers.tsx`：`scanProtocol` 状态类型从 `"openai" | "anthropic" | "gemini"` 放宽为 `Protocol`，并补充 `Protocol` 类型导入。

### 6. README 说明协议拆分

`README.md` 把 `/v1/responses` 行的协议列标为 `OpenAI Responses`，并新增一段说明：`openai` 与 `openai-responses` 是两个独立协议，各自维护 provider 链、互不 fallback，避免 Responses 请求被转发到不支持的第三方源。

## 验证

### 单元测试

```bash
bun test
```

结果：

```txt
 12 pass
 0 fail
 36 expect() calls
Ran 12 tests across 2 files.
```

### 类型检查

```bash
bunx tsc --noEmit
```

结果：`0 errors`。

### JSON 配置校验

```bash
bun -e "await Bun.file('config.json').json(); console.log('config json ok')"
```

结果：`config json ok`

### 本地黑盒验证（dev server，key `sk-gateway-placeholder`）

- `/v1/responses` ＋ `openai/gpt-5.5` → **200**，响应头含 `openai-organization` / `api.openai.com` cookie，确认直连官方 Responses API。
- `/v1/responses` ＋ `anthropic/claude-sonnet-4.6` → **404** `Model '...' is not exposed via openai-responses protocol`，确认 claude 不在 `openai-responses` 协议下、不会 fallback 到第三方源。
- `/v1/chat/completions` ＋ `openai/gpt-5.5` → **200**，确认 `openai` 协议（Chat Completions）链路不受影响。

## 提交

```txt
4a67e94 refactor: split openai responses into its own protocol
```
