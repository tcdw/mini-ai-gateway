# AI Gateway - 20260529 OpenAI 官方源与 Responses API 支持开发日志

## 背景

mini-ai-gateway 之前的 OpenAI 协议模型（`openai/gpt-5.5`、`openai/gpt-image-2`、`openai/text-embedding-3-large`）都只走第三方聚合源（OpenRouter / Vercel AI Gateway / AIHubMix），没有直连 OpenAI 官方网关的选项。

同时，网关在 OpenAI 协议侧只暴露了 `/v1/chat/completions`、`/v1/images/generations`、`/v1/embeddings`，对 OpenAI 新的 `/v1/responses`（Responses API）会直接返回 404，导致使用 Responses API 的客户端无法经由网关调用。

本次修改目标：

1. 接入 OpenAI 官方网关作为新的 provider，key 通过环境变量 `OPENAI_API_KEY` 提供。
2. 在不做协议翻译的前提下，复用现有协议感知转发，增加 OpenAI Responses API 的透传支持。

## 主要变更

### 1. 新增 `openai-official` provider

`config.json` 在 `providers` 中新增官方源，指向 OpenAI 官方 base URL，使用默认的 `Authorization: Bearer` 鉴权（OpenAI 协议默认即 Bearer，无需 `authHeader` 覆盖）。

```json
"openai-official": {
  "keyEnvVar": "OPENAI_API_KEY",
  "endpoints": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1"
    }
  }
}
```

### 2. 三个 OpenAI 模型把官方源放在首位

在 `openai/gpt-5.5`、`openai/gpt-image-2`、`openai/text-embedding-3-large` 的 `protocols.openai.providers` 列表里，把 `openai-official` 作为第一优先源加入，remap 去掉 `openai/` 前缀（官方接口直接用裸模型名）。其余第三方源保持原样作为 fallback。

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
    }
  }
}
```

`gpt-image-2` remap 为 `gpt-image-2`，`text-embedding-3-large` remap 为 `text-embedding-3-large`，逻辑相同。

### 3. 新增 OpenAI-compatible `/v1/responses` 路由

`index.ts` 新增 `handleOpenAIResponses`，结构与 chat / image / embeddings handler 完全一致：解析 JSON、校验 `model`，然后交给通用 `forwardToUpstream`，上游路径为 `responses`。

```ts
async function handleOpenAIResponses(
  req: Request,
  inboundUrl: URL,
): Promise<Response> {
  const body = await readJsonBody(req, "openai");
  if (body instanceof Response) return body;

  const modelName = body.model;
  if (typeof modelName !== "string" || !modelName) {
    return protocolError("openai", "model is required", 400);
  }

  return forwardToUpstream({
    protocol: "openai",
    modelName,
    method: "POST",
    body,
    inboundUrl,
    buildUpstreamPath: () => "responses",
  });
}
```

因此 `/v1/responses` 沿用既有行为：provider 链读取、`remap` 替换 body 里的 `model`、缺 key / 缺 endpoint 跳过、429 / 5xx 自动 fallback、响应原样透传（SSE 流式也照常工作）。

### 4. 注册 responses 入口

`index.ts` 主 `fetch` 分支在 embeddings 之后注册路由：

```ts
} else if (url.pathname === "/v1/responses" && req.method === "POST") {
  res = await handleOpenAIResponses(req, url);
}
```

### 5. 文档与环境变量

- `.env.example` 在 Official 分组下新增 `OPENAI_API_KEY=`。
- `README.md` 协议端点表格新增一行 `/v1/responses | POST | OpenAI | OpenAI Responses API`。

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

### JSON 配置校验

```bash
bun -e "await Bun.file('config.json').json(); console.log('json ok')"
```

结果：`json ok`

### 本地黑盒验证

使用本地 dev server（PORT=3199）和测试 key `sk-gateway-placeholder`：

- `/v1/responses` 传未知模型 `does/not-exist` → 返回 `Model 'does/not-exist' not found`，证明路由已接上（不再是 404 Not found）。
- `/v1/responses` 传 `openai/gpt-5.5`（环境已配置 `OPENAI_API_KEY`）→ 经 `openai-official` 直连官方 Responses API 成功，返回真实模型 `gpt-5.5-2026-04-23` 的 `response` 对象，确认官方源优先、remap 生效、透传正常。
- `/v1/responses` 传 `"stream": true` + `curl -N` → SSE 逐块到达：`response.created` → `response.in_progress` → reasoning / message item → 多个 `response.output_text.delta` → `response.output_text.done` → `response.completed`，确认流式透传无缓冲、低延迟正常。

## 提交

```txt
854e4f4 feat: add openai official provider and responses api support
```
