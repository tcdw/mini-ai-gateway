# AI Gateway - 20260517 OpenCode Modalities 元数据开发日志

## 背景

OpenCode 对 models.dev 内置 provider 会自动拉取模型元数据，但对自定义 OpenAI-compatible provider 不会自动知道模型能力。

因此，当 mini-ai-gateway 作为自定义 provider 接入 OpenCode 时，如果 `opencode.json` 里的模型没有显式声明 `modalities`，OpenCode 会把这些模型当成纯文本模型处理。实际影响是图片、PDF 等多模态输入在客户端侧就可能不可用。

本次修改目标是：

- 从 models.dev 同步模型能力元数据
- 将能力信息写入 `models-meta.json`
- 让 Admin UI 生成的 OpenCode 配置自动包含 `modalities`
- 保持 `/v1/models` 和配置生成器共用同一份模型元数据

## 主要变更

### 1. 扩展模型元数据结构

`packages/core/src/types.ts` 的 `ModelMeta` 新增可选字段：

```ts
modalities?: {
  input: string[];
  output: string[];
};
```

这个字段直接对应 OpenCode provider model config 里使用的 `modalities` 结构，例如：

```json
{
  "input": ["text", "image", "pdf"],
  "output": ["text"]
}
```

### 2. 同步脚本写入 modalities

`scripts/sync-models.ts` 现在会从 `https://models.dev/api.json` 读取每个模型的：

- `name`
- `limit.context`
- `limit.output`
- `modalities.input`
- `modalities.output`

同步逻辑从原来的“已有 meta 就跳过”调整为“重新比对并更新变化内容”。这样后续 models.dev 更新模型能力时，再运行同步脚本就能刷新本地 `models-meta.json`。

脚本仍然保留原有的模型匹配策略：

- 优先尝试配置里的虚拟模型 ID
- 再尝试模型短名
- 再尝试每个 provider mapping 的 `remap`
- 最后尝试 `remap` 短名

### 3. OpenCode 配置生成器输出完整模型列表

`packages/core/src/client-config.ts` 的 OpenCode 生成逻辑现在接收：

- `modelIds`
- `modelsMeta`

生成的 OpenCode 配置会为当前网关配置里的所有模型生成显式条目：

```json
{
  "provider": {
    "mini-ai-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://localhost:3000/v1",
        "apiKey": "{env:GATEWAY_API_KEY}"
      },
      "models": {
        "openai/gpt-5.5": {
          "name": "OpenAI: GPT-5.5",
          "modalities": {
            "input": ["text", "image", "pdf"],
            "output": ["text"]
          }
        }
      }
    }
  },
  "model": "mini-ai-gateway/openai/gpt-5.5"
}
```

默认模型仍然由顶层 `model` 字段指定，不影响用户在 OpenCode 里选择其它模型。

### 4. Admin API 传入模型元数据

`index.ts` 的 `/admin/api/client-config` 现在调用 `generateClientConfig` 时传入：

- `Object.keys(cfg.models)`
- `modelsMeta`

因此 Admin UI 的 Client Config 页面无需额外前端改动，就能生成包含 `modalities` 的 OpenCode 配置。

### 5. `/v1/models` 透出 modalities

`GET /v1/models` 返回模型列表时，如果 `models-meta.json` 中存在 `modalities`，也会一并返回。

这样网关的模型列表接口和 OpenCode 配置生成器使用同一份事实来源，避免以后出现一个入口有能力信息、另一个入口没有能力信息的情况。

## 元数据更新结果

运行 `bun run scripts/sync-models.ts` 后，本地 `models-meta.json` 已补齐当前 `config.toml` 中模型的能力信息。

示例：

- `openai/gpt-5.5`: input `text`, `image`, `pdf`; output `text`
- `google/gemini-3.1-pro-preview`: input `audio`, `image`, `pdf`, `text`, `video`; output `text`
- `google/gemini-3.1-flash-image-preview`: input `image`, `text`; output `image`, `text`
- `openai/gpt-image-2`: input `text`, `image`; output `image`

部分不在当前 `config.toml` 路由中的旧 meta 条目仍然保留在 `models-meta.json` 中，避免同步脚本意外删除历史缓存。

## 测试与验证

新增 `packages/core/src/client-config.test.ts`，覆盖 OpenCode 配置生成器的关键行为：

- 顶层默认模型仍然生成 `mini-ai-gateway/<model-id>`
- provider 下会包含所有传入的模型 ID
- 模型条目会带上对应的 `modalities`

本次验证过：

```bash
bun run scripts/sync-models.ts
bun test
bunx tsc --noEmit
bun build apps/admin/index.html --outdir /private/tmp/mini-ai-gateway-admin-build
```

结果：

- models.dev 同步成功，配置内 14 个模型全部命中
- `bun test` 通过
- TypeScript 检查通过
- Admin 前端构建通过

## 提交

本次功能提交：

```txt
6c162ae Add OpenCode model modalities metadata
```
