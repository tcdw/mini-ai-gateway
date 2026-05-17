# AI Gateway - 20260517 Anthropic 协议别名开发日志

## 背景

多协议透传落地后，网关同时支持 OpenAI、Anthropic、Gemini 三种协议入口。其中 Anthropic Messages API 使用 `POST /v1/messages`，而 OpenAI 模型列表也长期使用 `GET /v1/models`。

理论上可以通过 `anthropic-version` / `anthropic-beta` header 判断客户端是否在使用 Anthropic API。但实际测试发现，不是所有 Anthropic 兼容客户端都会在拉取模型列表时携带这些 header。例如 Cherry Studio 在选择 provider 类型为 Anthropic 时，请求模型列表仍然只带 `x-api-key`。

因此，裸 `GET /v1/models` 不能可靠区分客户端想要 OpenAI 模型列表还是 Anthropic 模型列表。本次修改引入 `/anthropic/v1/*` 作为 Anthropic 协议的显式别名入口，让客户端可以通过 base URL path prefix 明确表达协议意图。

## 主要变更

### 1. 新增 Anthropic 模型列表响应

`index.ts:117` 增加 `buildAnthropicModelInfo`，把本地模型配置转换成 Anthropic Models API 风格的模型对象：

```ts
function buildAnthropicModelInfo(modelId: string) {
  const meta = modelsMeta[modelId];
  return {
    id: modelId,
    type: "model",
    display_name: meta?.name ?? modelId,
    ...(meta
      ? {
          max_input_tokens: meta.context_window,
          max_tokens: meta.max_output_tokens,
        }
      : {}),
  };
}
```

`index.ts:132` 的 `getAnthropicModelsList` 只列出 `protocols.anthropic` 非空的模型，并返回 Anthropic 分页形状：

```ts
return jsonResponse(
  {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
  },
  200,
);
```

同时补了 `GET /anthropic/v1/models/{model_id}` 对应的单模型查询，避免部分 SDK 或客户端做模型校验时只能 list 不能 retrieve。

### 2. `/anthropic/v1/*` 协议别名

`index.ts:484` 增加 `stripAnthropicAliasPath`，用于识别并剥离 `/anthropic` 前缀：

```ts
function stripAnthropicAliasPath(pathname: string): string | null {
  if (pathname === "/anthropic") return "/";
  if (!pathname.startsWith("/anthropic/")) return null;
  return pathname.slice("/anthropic".length);
}
```

主路由在 `index.ts:761` 优先处理这个 alias：

| 路径 | 方法 | 行为 |
| --- | --- | --- |
| `/anthropic/v1/models` | GET | 返回 Anthropic 模型列表 |
| `/anthropic/v1/models/{model_id}` | GET | 返回 Anthropic 单模型对象 |
| `/anthropic/v1/messages` | POST | 复用 Anthropic Messages 透传 |
| `/anthropic/v1/messages/count_tokens` | POST | 复用 Anthropic count_tokens 透传 |

关键分支：

```ts
} else if (anthropicAliasPath !== null) {
  if (anthropicAliasPath === "/v1/models" && req.method === "GET") {
    res = getAnthropicModelsList();
  } else if (
    anthropicAliasPath.startsWith("/v1/models/") &&
    req.method === "GET"
  ) {
    const modelId = decodeURIComponent(
      anthropicAliasPath.slice("/v1/models/".length),
    );
    res = getAnthropicModel(modelId);
  } else if (
    anthropicAliasPath === "/v1/messages" &&
    req.method === "POST"
  ) {
    res = await handleAnthropicMessages(req, url, "messages");
  }
}
```

这样 Cherry Studio 这类客户端只要把 Anthropic provider 的 base URL 配成：

```txt
http://localhost:3000/anthropic
```

客户端实际请求 `/v1/models` 时会落到网关的 `/anthropic/v1/models`，不再依赖 header 嗅探。

### 3. 保留裸 `/v1/models` 的兼容嗅探

裸 `GET /v1/models` 仍默认返回 OpenAI 模型列表，避免破坏 OpenAI 兼容客户端。

同时 `index.ts:490` 增加 `wantsAnthropicModels`，让显式携带 Anthropic header 或 gateway override 的客户端仍能在裸路径拿到 Anthropic 模型列表：

```ts
function wantsAnthropicModels(req: Request): boolean {
  return (
    req.headers.has("anthropic-version") ||
    req.headers.has("anthropic-beta") ||
    req.headers.get("x-gateway-protocol") === "anthropic"
  );
}
```

主路由中的裸 `/v1/models` 逻辑：

```ts
} else if (url.pathname === "/v1/models" && req.method === "GET") {
  res = wantsAnthropicModels(req)
    ? getAnthropicModelsList()
    : getOpenAIModelsList();
}
```

这保持了最大兼容面：

- OpenAI 客户端继续使用 `/v1/models`
- Anthropic 客户端优先使用 `/anthropic/v1/models`
- 可控客户端也可以使用 `x-gateway-protocol: anthropic`

### 4. 协议感知错误体推断

`index.ts:498` 新增 `inferProtocolFromPath`，让 auth 失败和 404 时可以按路径返回对应协议方言的错误体：

```ts
function inferProtocolFromPath(pathname: string): Protocol {
  if (pathname.startsWith("/v1beta")) return "gemini";
  if (
    pathname === "/anthropic" ||
    pathname.startsWith("/anthropic/") ||
    pathname.startsWith("/v1/messages")
  ) {
    return "anthropic";
  }
  return "openai";
}
```

因此 `/anthropic/*` 下的认证失败、未命中路由都会返回 Anthropic error body，而不是 OpenAI error body。

### 5. Claude Code / Anthropic 客户端配置改用 alias root

`packages/core/src/client-config.ts:27` 新增 `anthropicRootBaseUrl`，把传入的 `/v1` root 转成 `/anthropic` root：

```ts
function anthropicRootBaseUrl(baseUrl: string): string {
  const root = rootBaseUrl(baseUrl);
  return root.endsWith("/anthropic") ? root : `${root}/anthropic`;
}
```

Claude Code 配置模板现在输出：

```sh
export ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"
export ANTHROPIC_AUTH_TOKEN="$GATEWAY_API_KEY"
export ANTHROPIC_API_KEY=""
export ANTHROPIC_MODEL="anthropic/claude-opus-4.7"
```

Admin UI 的 Client Config 页面也同步调整：`apps/admin/src/main.tsx:686` 中选择 `claude-code` 时，默认 Base URL 变成 `${window.location.origin}/anthropic`。

### 6. 新增配置生成器测试

`packages/core/src/client-config.test.ts` 增加用例，确认 Claude Code 配置会生成 `/anthropic` alias root：

```ts
test("claude-code config uses anthropic protocol alias root", () => {
  const text = generateClientConfig("claude-code", {
    baseUrl: "http://localhost:3000/v1",
    apiKeyEnvVar: "GATEWAY_API_KEY",
    defaultModel: "anthropic/claude-opus-4.7",
  });

  expect(text).toContain('ANTHROPIC_BASE_URL="http://localhost:3000/anthropic"');
  expect(text).toContain('ANTHROPIC_MODEL="anthropic/claude-opus-4.7"');
});
```

## 验证

### 单元测试

```bash
$ bun test
 12 pass
 0 fail
 36 expect() calls
Ran 12 tests across 2 files.
```

### 类型检查

```bash
$ bunx tsc --noEmit
# 无输出，检查通过
```

### Admin 构建

```bash
$ bun run build:admin
@mini-ai-gateway/admin build: Bundled 3118 modules in 258ms
@mini-ai-gateway/admin build: Exited with code 0
```

### 本地路由验证

临时启动网关：

```bash
PORT=3999 GATEWAY_API_KEY=test bun run index.ts
```

验证 `/anthropic/v1/models` 只带 `x-api-key` 也能返回 Anthropic 模型列表：

```bash
curl -s -H 'x-api-key: test' \
  http://localhost:3999/anthropic/v1/models
```

关键响应形状：

```json
{
  "data": [
    {
      "id": "anthropic/claude-opus-4.7",
      "type": "model",
      "display_name": "Claude Opus 4.7",
      "max_input_tokens": 409600,
      "max_tokens": 128000
    }
  ],
  "first_id": "anthropic/claude-opus-4.7",
  "has_more": false,
  "last_id": "anthropic/claude-opus-4.7"
}
```

验证单模型查询：

```bash
curl -s -H 'x-api-key: test' \
  http://localhost:3999/anthropic/v1/models/anthropic%2Fclaude-opus-4.7
```

关键响应形状：

```json
{
  "id": "anthropic/claude-opus-4.7",
  "type": "model",
  "display_name": "Claude Opus 4.7",
  "max_input_tokens": 409600,
  "max_tokens": 128000
}
```

验证裸 `/v1/models` 仍返回 OpenAI 格式：

```bash
curl -s -H 'x-api-key: test' \
  http://localhost:3999/v1/models
```

关键响应形状：

```json
{
  "object": "list",
  "data": [
    {
      "id": "openai/gpt-5.5",
      "object": "model"
    }
  ]
}
```

## 提交

代码改动当前尚未提交。按照 devlog 规范，代码提交后需要把实际 commit hash 补到这里，再单独提交本文档。

```txt
72f5b05 feat: add anthropic protocol alias routes
```
