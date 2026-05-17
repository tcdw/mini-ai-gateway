# AI Gateway - 20260517 多协议透传（Anthropic + Gemini）开发日志

## 背景

此前网关只暴露 OpenAI Chat Completions / Images 两个端点。Anthropic SDK（Claude Code、Cherry Studio 等）和 `@google/genai` SDK 都用各自的原生协议，必须借助像 OpenRouter / Vercel AI Gateway 这种"协议翻译式"上游才能间接接入。

但实际上：

- **OpenRouter**：通过 `POST /api/v1/messages` 暴露 Anthropic 兼容入口
- **Vercel AI Gateway**：`POST /v1/messages` 暴露 Anthropic 入口
- **AiHubMix**：同时暴露 OpenAI、Anthropic、Gemini 三种协议入口
- **Google 官方**：`generativelanguage.googleapis.com/v1beta` 是 Gemini 协议本家

既然上游们已经各自做了协议适配，那网关其实**完全不需要做协议翻译这种脏活**，只要按客户端打入的协议把请求透传到说同种语言的上游就行。这次改造就是把这个"多协议透传 + 协议感知 fallback"模型落地。

核心原则：**坚决不做协议翻译**。客户端发什么协议，网关就找说同种协议的上游透传；fallback 也只在同协议内进行。

## 主要变更

### 1. 数据模型扩展：Protocol + endpoints + protocols

`packages/core/src/types.ts` 重写，引入 `Protocol` 联合类型和按协议分组的结构：

```ts
export type Protocol = "openai" | "anthropic" | "gemini";

export interface ProtocolEndpoint {
  baseUrl: string;
  authHeader?: string;  // 可选覆盖；默认按协议推断
}

export interface ProviderConfig {
  keyEnvVar: string;
  endpoints: Partial<Record<Protocol, ProtocolEndpoint>>;
}

export interface ModelRoute {
  protocols: Partial<Record<Protocol, { providers: ModelProvider[] }>>;
}
```

关键决策：

- **每个 provider 按协议各自维护 endpoint**：Vercel 的 OpenAI base 是 `/v1`、Anthropic base 也是 `/v1`，但 AiHubMix 的 Gemini base 是 `/gemini` 这种特殊路径，无法用统一 base + 协议默认子路径模型概括
- **每个 model 在每种协议下都有独立的 provider 优先级**：同一个 `anthropic/claude-opus-4.7` 在 OpenAI 协议下可能走 `OR → VC → AHM`，在 Anthropic 协议下可能走 `OR → VC → AHM`（remap 名甚至不同）

### 2. 配置加载的向后兼容

`packages/core/src/config.ts:38-93` 的 `normalizeConfig` 自动把老格式映射到新格式：

- 顶层 `[providers.x] baseUrl/authHeader` → `endpoints.openai`
- 顶层 `[[models.x.providers]]` → `protocols.openai.providers`

老的 `config.toml` 不改也能继续跑；通过 Admin UI 写回时自动升级为新格式。

### 3. 协议感知 auth header

新增 `packages/core/src/protocol.ts`，统一处理协议默认 auth：

```ts
export function buildAuthHeaders(
  endpoint: ProtocolEndpoint,
  protocol: Protocol,
  apiKey: string,
): Record<string, string>
```

默认规则：
- `openai` → `Authorization: Bearer <key>`
- `anthropic` → `Authorization: Bearer <key>`（也可显式配 `x-api-key`）
- `gemini` → `x-goog-api-key: <key>`

`endpoint.authHeader` 可显式覆盖。

### 4. 协议方言错误体

`buildProtocolErrorBody(protocol, payload)` 按协议返回对应方言的错误体，让严格 SDK 能正确解析：

- OpenAI：`{error: {message, type, code}}`
- Anthropic：`{type: "error", error: {type, message}}`
- Gemini：`{error: {code, message, status}}`（带 `INVALID_ARGUMENT`/`UNAVAILABLE` 等 status 字符串）

### 5. 通用 `forwardToUpstream`

`index.ts:140-280` 改造成协议无关的转发器，接收 `ForwardOptions`：

```ts
interface ForwardOptions {
  protocol: Protocol;
  modelName: string;
  method: "GET" | "POST";
  forwardHeaders?: Headers;
  body?: Record<string, unknown>;
  buildUpstreamPath: (args: {
    endpoint: ProtocolEndpoint;
    remap: string;
    inboundUrl: URL;
  }) => string;
  transformBody?: (body: Record<string, unknown>, remap: string) => unknown;
  inboundUrl: URL;
}
```

关键差异处理：

- **OpenAI / Anthropic**：默认 `transformBody` 替换 `body.model = remap`
- **Gemini**：`body` 原样透传，model 名通过 `buildUpstreamPath` 拼到 URL path（`v1beta/models/{remap}:{action}`）
- **Anthropic**：转发入站的 `anthropic-version` / `anthropic-beta` header
- **Gemini SSE**：保留 `?alt=sse` 等 query 参数，仅过滤掉客户端传入的 `?key=`

候选 provider 列表来自 `cfg.models[modelName].protocols[protocol].providers`，fallback 只在同协议内进行（跳过未配该协议 endpoint 或缺 env key 的 provider）。

### 6. 新增路由

`index.ts:570-620`：

| 路径 | 方法 | 协议 |
| --- | --- | --- |
| `/v1/messages` | POST | anthropic |
| `/v1/messages/count_tokens` | POST | anthropic |
| `/v1beta/models` | GET | gemini |
| `/v1beta/models/{model}:{action}` | POST | gemini |

Gemini path 解析在 `parseGeminiModelAction` 中按 `:` 分割，支持 `:generateContent` / `:streamGenerateContent` / `:countTokens` 等任意 action 后缀。

### 7. 三种认证 header 都接受 `GATEWAY_API_KEY`

`index.ts:546-560`：网关入口同时识别 `Authorization: Bearer`、`x-api-key`、`x-goog-api-key`、`?key=` 四种方式呈递的同一个 gateway key，让 Anthropic SDK / Gemini SDK / OpenAI SDK 都能无缝接入。auth 失败时按入站路径返回对应协议方言的错误体。

### 8. 模型列表的协议过滤

- `GET /v1/models` 只列出 `protocols.openai` 非空的 model
- `GET /v1beta/models` 只列出 `protocols.gemini` 非空的 model，按 Gemini 格式返回 `{models: [{name: "models/...", supportedGenerationMethods, ...}]}`
- Anthropic 没有标准 list 端点，本次未实现

### 9. Helper 函数全协议化

`packages/core/src/config.ts` 的 helper 全部加 `protocol: Protocol` 参数：

- `addModelMappings(cfg, providerName, protocol, modelIds)`
- `addModelProviderMapping(cfg, modelId, protocol, providerName, remap)`
- `removeModelProviderMapping(cfg, modelId, protocol, providerName)` — 新增，删空时自动清理协议/模型条目
- `reorderModelProviders(cfg, modelId, protocol, orderedProviderNames)`
- `upsertProviderEndpoint(cfg, providerName, protocol, endpoint)` — 新增
- `removeProviderEndpoint(cfg, providerName, protocol)` — 新增

### 10. `google-official` provider 接入

`config.toml` 加入 `GEMINI_API_KEY` 驱动的官方 endpoint：

```toml
[providers."google-official"]
keyEnvVar = "GEMINI_API_KEY"

[providers."google-official".endpoints.gemini]
baseUrl = "https://generativelanguage.googleapis.com"
```

所有 google 系 model 在 `protocols.gemini` 下，**`google-official` 排第一、`aihubmix` 兜底**：

```toml
[[models."google/gemini-3.1-pro-preview".protocols.gemini.providers]]
name = "google-official"
remap = "gemini-3.1-pro-preview"

[[models."google/gemini-3.1-pro-preview".protocols.gemini.providers]]
name = "aihubmix"
remap = "gemini-3.1-pro-preview"
```

### 11. Admin REST API 协议化

`index.ts` 的 admin 路由全部加 `protocol` 字段（缺省回退到 `openai` 保持兼容）：

- `POST /admin/api/providers/:provider/models/scan` — body 加 `{protocol}`
- `POST /admin/api/models/mappings` — body 加 `{protocol}`
- `POST /admin/api/models/:modelId/providers` — body 加 `{protocol}`
- `PATCH /admin/api/models/:modelId/providers` — body 加 `{protocol}`
- `DELETE /admin/api/models/:modelId/providers` — 新增
- `PATCH /admin/api/providers/:provider/endpoints/:protocol` — 新增
- `DELETE /admin/api/providers/:provider/endpoints/:protocol` — 新增

### 12. Admin UI 协议矩阵

`apps/admin/src/main.tsx` 重写：

- **Models 页**：表格每个协议一列，单元格内展示该协议下的 provider 链（带 close 按钮可删除）+ 多选排序
- **Providers 页**：新增「Support matrix」表格，行 = provider、列 = 协议，单元格显示 endpoint base URL + auth header，支持就地 Edit / Remove / Scan
- **Client Config 页**：新增 `claude-code`、`gemini-cli` 客户端类型，根据所选类型自动调整 base URL（带 `/v1` 与否）

`packages/core/src/client-config.ts` 新增两个模板：

- `claude-code`：输出 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY=""` / `ANTHROPIC_MODEL` shell 片段
- `gemini-cli`：输出 `GOOGLE_GEMINI_BASE_URL` / `GEMINI_API_KEY` + `@google/genai` 调用示例

### 13. `scanProviderModels` 支持 Gemini

`packages/core/src/providers.ts` 增加 `protocol` 参数，根据协议切换扫描路径：

- `openai` / `anthropic` → `GET <base>/models`（OpenAI 兼容格式）
- `gemini` → `GET <base>/v1beta/models`，结果展平 `models/<id>` 前缀

## 验证

### 单元测试

```bash
$ bun test
 11 pass
 0 fail
 34 expect() calls
Ran 11 tests across 2 files.
```

新增覆盖：legacy → new 格式迁移、新格式 round-trip、按协议的 helper、auth header 默认值、错误体方言。

### 类型与构建

```bash
$ bunx tsc --noEmit       # 无错
$ bun run build:admin     # Bundled 3118 modules in 135ms
```

### 端到端真实调用

| 场景 | 上游 | 结果 |
| --- | --- | --- |
| `POST /v1/messages`（Bearer） | OpenRouter → Claude Opus 4.7 | ✅ 200 |
| `POST /v1/messages`（`x-api-key`） | OpenRouter | ✅ 200 |
| `POST /v1/messages` fallback | OpenRouter 禁用 → Vercel | ✅ 200 |
| `POST /v1beta/.../:generateContent` | google-official | ✅ 200 |
| `POST /v1beta/.../:streamGenerateContent?alt=sse` | google-official（SSE 透传无延迟） | ✅ 200 |
| Gemini fallback | google-official 禁用 → AiHubMix | ✅ 200 |
| Admin endpoint PATCH/DELETE | — | ✅ config.toml round-trip 正确 |

实测客户端：

- **Cherry Studio + Anthropic 协议** → `[Gateway] → anthropic:openrouter (anthropic/claude-opus-4.7) — 200`
- **Cherry Studio + Gemini 协议** → `[Gateway] → gemini:google-official (google/gemini-3.1-pro-preview) — 200`

两个客户端都正确识别协议类型并显示对应的 model 标签（"碗的 AI Gateway (Anthropic)" / "(Google)"），网关日志显示协议感知 fallback 第一档命中、无翻译、无缓冲。

## 提交

```txt
2846bac feat: add anthropic /v1/messages and gemini /v1beta passthrough
```
