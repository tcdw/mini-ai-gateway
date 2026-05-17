# AI Gateway - 20260517 Image Generation 端点开发日志

## 背景

OpenAI 的 `/v1/images/generations` 接口用于图像生成（DALL·E、gpt-image-2 等模型）。mini-ai-gateway 此前只实现了 `/v1/chat/completions`，导致客户端调用 image 接口时收到 404：

```
[Gateway] POST /v1/images/generations → 404 (0ms)
```

本次修改目标是让网关支持 Image Generation 路由，并复用已有的 sequential fallback 机制。

## 主要变更

### 1. 提取 `forwardToUpstream` 通用转发函数

`handleChatCompletion` 里的 fallback 逻辑（模型查找 → provider 匹配 → API key 校验 → remap → 上游请求 → 可重试状态判断）实际上是通用的 OpenAPI 路由逻辑。

本次将其提取为 `forwardToUpstream`：

```ts
async function forwardToUpstream(
  modelName: string,
  body: Record<string, unknown>,
  upstreamPath: string,
): Promise<Response>
```

核心转发链路保持不变：

- 从 `cfg.models[modelName]` 查找模型路由
- 遍历 `providers` 列表，过滤掉无配置 / 无 API key 的 provider
- 用 `remap` 替换 body 中的 model 名
- POST 到 `{baseUrl}/{upstreamPath}`
- 对 429 / 5xx 自动 fallback 到下一个 provider
- 对 4xx（非 429）直接透传错误

### 2. `handleChatCompletion` 精简

重构后 `handleChatCompletion` 只负责 JSON 解析和 model 校验，转发委托给通用函数：

```ts
async function handleChatCompletion(req: Request): Promise<Response> {
  // ... parse body, validate model ...
  return forwardToUpstream(modelName, body, "chat/completions");
}
```

### 3. 新增 `handleImageGeneration`

```ts
async function handleImageGeneration(req: Request): Promise<Response> {
  // ... parse body, validate model ...
  return forwardToUpstream(modelName, body, "images/generations");
}
```

与 chat 端点结构一致，区别仅在于 `upstreamPath` 为 `images/generations`。

### 4. 注册路由

在 `fetch` handler 中新增：

```ts
} else if (
  url.pathname === "/v1/images/generations" &&
  req.method === "POST"
) {
  res = await handleImageGeneration(req);
}
```

## 验证

```bash
bun build --target=bun index.ts --outdir=/tmp/ai-gw-check
```

编译通过，无类型错误。

## 提交

```txt
b54b431 feat: add /v1/images/generations endpoint for image models
```
