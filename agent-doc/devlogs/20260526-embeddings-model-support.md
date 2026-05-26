# AI Gateway - 20260526 Embeddings 模型支持开发日志

## 背景

mini-ai-gateway 此前已经支持 OpenAI Chat Completions / Images、Anthropic Messages 和 Gemini 原生生成接口，但 OpenAI 兼容的 `/v1/embeddings` 仍会返回 404，Gemini 模型列表也只声明 `generateContent` / `streamGenerateContent`。

这导致 embedding 模型即使配置到 `config.json`，客户端也无法通过网关正常调用向量接口；Gemini SDK 侧查看 `/v1beta/models` 时，也看不到 embedding 模型应声明的 `embedContent` 能力。

本次修改目标是：在不做协议翻译的前提下，让 OpenAI-compatible embeddings 和 Gemini 原生 embeddings 都复用现有协议感知转发、模型 remap、provider priority 和 fallback 机制。

## 主要变更

### 1. 新增 OpenAI-compatible `/v1/embeddings` 路由

`index.ts:426-445` 新增 `handleOpenAIEmbeddings`，结构与 chat/image handler 保持一致：解析 JSON、校验 `model`，然后交给通用 `forwardToUpstream`。

```ts
async function handleOpenAIEmbeddings(
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
    buildUpstreamPath: () => "embeddings",
  });
}
```

这样 `/v1/embeddings` 会沿用已有行为：

- 从 `cfg.models[modelName].protocols.openai.providers` 读取 provider 链
- 用 provider mapping 的 `remap` 替换上游请求体里的 `model`
- 缺 key / 缺 endpoint 时跳过 provider
- 对 429 / 5xx 自动 fallback
- 对上游响应原样透传

### 2. 注册 embeddings 入口

`index.ts:846-847` 在主 `fetch` 分支中注册 OpenAI embeddings 路由：

```ts
} else if (url.pathname === "/v1/embeddings" && req.method === "POST") {
  res = await handleOpenAIEmbeddings(req, url);
}
```

因此 OpenAI SDK / OpenAI-compatible SDK 可以继续使用 `http://localhost:3000/v1` 作为 base URL，通过 `client.embeddings.create(...)` 打到网关。

### 3. Gemini 模型列表按 embedding 模型声明能力

`GET /v1beta/models` 原来对所有 Gemini 协议模型都固定返回生成能力。`index.ts:183` 改为调用 helper：

```ts
supportedGenerationMethods: getGeminiSupportedGenerationMethods(modelId),
```

`index.ts:195-201` 新增判断逻辑：只要模型 metadata 的输出 modality 包含 `embedding`，或模型 ID 含 `embedding`，就声明 Gemini embedding 方法。

```ts
function getGeminiSupportedGenerationMethods(modelId: string): string[] {
  const outputModalities = modelsMeta[modelId]?.modalities?.output ?? [];
  if (outputModalities.includes("embedding") || modelId.includes("embedding")) {
    return ["embedContent", "batchEmbedContents"];
  }
  return ["generateContent", "streamGenerateContent"];
}
```

Gemini 原生 `POST /v1beta/models/{model}:embedContent` 不需要新 handler，因为已有 `handleGeminiGenerate` 会解析任意 `{model}:{action}` 后缀，并把 action 拼到上游路径中透传。

### 4. 增加 OpenAI 和 Gemini embedding 模型配置

对照 OpenRouter 与 Vercel AI Gateway 的模型列表后，OpenRouter 公开 `/models` 未暴露 embedding 模型条目；Vercel AI Gateway 暴露了 embedding 模型，其中包括：

- `openai/text-embedding-3-large`
- `google/gemini-embedding-2`

因此 `config.json` 中新增两个虚拟模型。

`config.json:106-117`：OpenAI embedding 走 Vercel 的 OpenAI-compatible endpoint。

```json
"openai/text-embedding-3-large": {
  "protocols": {
    "openai": {
      "providers": [
        {
          "name": "vercel",
          "remap": "openai/text-embedding-3-large"
        }
      ]
    }
  }
}
```

`config.json:254-273`：Gemini embedding 同时暴露 OpenAI-compatible 和 Gemini 原生协议。

```json
"google/gemini-embedding-2": {
  "protocols": {
    "openai": {
      "providers": [
        {
          "name": "vercel",
          "remap": "google/gemini-embedding-2"
        }
      ]
    },
    "gemini": {
      "providers": [
        {
          "name": "google-official",
          "remap": "gemini-embedding-2"
        }
      ]
    }
  }
}
```

### 5. 补充 embedding 模型 metadata

`models-meta.json:234-265` 增加两个 embedding 模型的元数据，并明确 `modalities.output = ["embedding"]`，供 `/v1/models`、OpenCode 配置生成和 Gemini 模型列表能力判断使用。

```json
"openai/text-embedding-3-large": {
  "id": "openai/text-embedding-3-large",
  "name": "OpenAI: Text Embedding 3 Large",
  "context_window": 8191,
  "max_output_tokens": 0,
  "modalities": {
    "input": ["text"],
    "output": ["embedding"]
  }
},
"google/gemini-embedding-2": {
  "id": "google/gemini-embedding-2",
  "name": "Google: Gemini Embedding 2",
  "context_window": 2048,
  "max_output_tokens": 0,
  "modalities": {
    "input": ["text", "image", "audio", "video", "pdf"],
    "output": ["embedding"]
  }
}
```

### 6. README 更新支持端点

`README.md` 中补充 OpenAI Embeddings 和 Gemini Embeddings 入口，避免文档仍只描述生成类端点：

```md
| `/v1/embeddings`                                      | POST   | OpenAI    | OpenAI Embeddings |
| `/v1beta/models/{model}:embedContent`                 | POST   | Gemini    | Gemini Embeddings |
| `/v1beta/models/{model}:batchEmbedContents`           | POST   | Gemini    | Gemini 批量 Embeddings |
```

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
bun -e "await Bun.file('config.json').json(); await Bun.file('models-meta.json').json(); console.log('json ok')"
```

结果：

```txt
json ok
```

### TypeScript 类型检查

```bash
bunx tsc --noEmit
```

结果：未通过，但失败点是现有 Admin 生成路由文件缺失，和本次 embeddings 改动无关：

```txt
apps/admin/src/main.tsx(9,27): error TS2307: Cannot find module './routeTree.gen' or its corresponding type declarations.
apps/admin/src/routes/client-config.tsx(9,38): error TS2345: Argument of type '"/client-config"' is not assignable to parameter of type 'undefined'.
apps/admin/src/routes/index.tsx(19,38): error TS2345: Argument of type '"/"' is not assignable to parameter of type 'undefined'.
apps/admin/src/routes/providers.tsx(37,38): error TS2345: Argument of type '"/providers"' is not assignable to parameter of type 'undefined'.
apps/admin/src/routes/stats.tsx(4,38): error TS2345: Argument of type '"/stats"' is not assignable to parameter of type 'undefined'.
```

### 本地黑盒验证

使用本地 dev server 和测试 key `sk-gateway-placeholder` 验证：

- `/v1/models` 包含 `openai/text-embedding-3-large` 和 `google/gemini-embedding-2`
- `openai/text-embedding-3-large` 经 `/v1/embeddings` 成功，返回向量维度 `3072`
- `google/gemini-embedding-2` 经 `/v1/embeddings` 成功，返回向量维度 `3072`
- `/v1beta/models` 中 `google/gemini-embedding-2` 声明 `embedContent` / `batchEmbedContents`
- `google/gemini-embedding-2` 经 Gemini 原生 `:embedContent` 成功，返回向量维度 `3072`

## 提交

```txt
c65f94c feat: add embeddings model support
```
