# AI Gateway

一个**极致轻量、专注转发**的私有多协议 AI API 网关。

专为“自己使用多渠道 API”的场景设计，将散落在各处的 Provider（OpenRouter、Vercel AI Gateway、AiHubMix、Google 官方等）收拢为一个统一的入口。客户端只需认准统一的虚拟模型 ID（如 `openai/gpt-5.5`），网关会按配置顺序使用第一个可用 Provider，遇 429/5xx 自动回退到下一个。

同一个模型可以同时通过 **OpenAI Chat Completions / Images / Embeddings**、**Anthropic Messages**、**Google Gemini** 三种原生协议暴露 —— 客户端用什么协议打进来，网关就把请求**原样透传**给同样讲该协议的上游。不做协议翻译。

## ✨ 特性 (Features)

*   **极简核心**：基于 [Bun](https://bun.sh) 原生 HTTP `serve()` 构建，零外部依赖，极速启动与响应。
*   **多协议透传**：同时支持 OpenAI Chat Completions / Images / Embeddings、Anthropic Messages、Google Gemini 三种原生协议入口。
*   **协议感知 fallback**：每个 (model, protocol) 组合都有独立的 provider 优先级，互不干扰；遇 429/5xx 自动跳过到下一个。
*   **配置即路由**：使用直观的 TOML 配置文件定义 Provider 与模型映射。
*   **本地 Admin UI**：内置 React 管理台，支持「Provider × Protocol 支持矩阵」、按协议调整路由、扫描上游模型、生成客户端配置。
*   **元数据同步**：自带爬虫脚本同步 models.dev 元数据，完美支持客户端的 `/v1/models` 容量查询。
*   **原生流式透传**：无缓冲直接透传 SSE 流，不增加首字节延迟（TTFB）。

## 🚫 不做的事情 (Non-Goals)

为了保持项目的轻量与专注，本网关**不会**实现以下功能：

*   **协议翻译（Protocol Translation）**：不在不同协议之间做字段映射（如 Anthropic ↔ OpenAI、Gemini ↔ OpenAI）。客户端用什么协议进来，网关就找说同种协议的上游透传；遇到上游不支持目标协议就让该 (model, protocol) 配置缺失。
*   **多租户与计费**：没有用户管理、没有 Quota 限制、没有额度统计面板。网关假定只有一个信任的拥有者在使用。
*   **复杂后台系统**：Admin UI 仅面向本地自用，不提供用户管理、审计流、审批流等重型后台能力。

## 🔌 支持的协议端点

| Path                                                  | Method | Protocol  | 说明 |
| ----------------------------------------------------- | :----: | :-------: | --- |
| `/v1/chat/completions`                                | POST   | OpenAI    | OpenAI Chat Completions |
| `/v1/images/generations`                              | POST   | OpenAI    | OpenAI Image Generation |
| `/v1/embeddings`                                      | POST   | OpenAI    | OpenAI Embeddings |
| `/v1/responses`                                       | POST   | OpenAI    | OpenAI Responses API |
| `/v1/models`                                          | GET    | OpenAI    | 列出所有暴露 openai 协议的模型 |
| `/v1/messages`                                        | POST   | Anthropic | Anthropic Messages API |
| `/v1/messages/count_tokens`                           | POST   | Anthropic | Anthropic 计算 token 数 |
| `/v1beta/models`                                      | GET    | Gemini    | 列出所有暴露 gemini 协议的模型 |
| `/v1beta/models/{model}:generateContent`              | POST   | Gemini    | Gemini 同步生成 |
| `/v1beta/models/{model}:streamGenerateContent`        | POST   | Gemini    | Gemini SSE 流式生成 |
| `/v1beta/models/{model}:embedContent`                 | POST   | Gemini    | Gemini Embeddings |
| `/v1beta/models/{model}:batchEmbedContents`           | POST   | Gemini    | Gemini 批量 Embeddings |
| `/v1beta/models/{model}:countTokens`                  | POST   | Gemini    | Gemini 计算 token 数 |

认证支持三种 header，**均使用同一个 `GATEWAY_API_KEY`**：

- `Authorization: Bearer <key>`（OpenAI / Anthropic / 通用）
- `x-api-key: <key>`（Anthropic SDK / Claude Code）
- `x-goog-api-key: <key>` 或 `?key=<key>`（Gemini SDK / @google/genai）

## 🚀 快速开始

### 1. 环境准备

确保你已安装 [Bun](https://bun.sh)。

### 2. 配置

创建 `.env` 文件填入你的密钥（网关会自动加载）：

```env
GATEWAY_API_KEY=sk-my-gateway-secret
PORT=3000

# Provider Keys
OPENROUTER_API_KEY=sk-or-v1-...
VERCEL_AI_KEY=vck_...
AIHUBMIX_API_KEY=sk-ah-...
GEMINI_API_KEY=AIza...
DEEPSEEK_API_KEY=sk-...
XIAOMI_API_KEY=sk-...
```

编辑 `config.json` 定义路由 —— 每个 provider 可以为它实际支持的协议各配一份 endpoint，每个 model 在每种协议下都有自己独立的 provider 优先级列表。详见自带配置。

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
        "openai": {
          "providers": [
            { "name": "vercel", "remap": "anthropic/claude-opus-4.7" }
          ]
        },
        "anthropic": {
          "providers": [
            { "name": "vercel", "remap": "anthropic/claude-opus-4.7" }
          ]
        }
      }
    }
  }
}
```

> 💡 旧的扁平格式（`baseUrl/authHeader` 在 `[providers.x]` 顶层、`[[models.x.providers]]` 无 protocol 标签）仍然向后兼容，加载时自动映射为 `openai` 协议；首次通过 Admin UI 写回时会升级为新格式。

### 3. 同步元数据 (可选)

如果你需要准确的 `/v1/models` 上下文长度数据：

```bash
bun run scripts/sync-models.ts
```

### 4. 启动网关

```bash
bun run index.ts
```

不同客户端的 base URL 形式略有不同：

| 客户端 | Base URL |
| ----- | -------- |
| OpenAI SDK / opencode / curl | `http://localhost:3000/v1` |
| Anthropic SDK / Claude Code  | `http://localhost:3000` （Anthropic SDK 内部会自己加 `/v1/messages`） |
| @google/genai / Gemini CLI   | `http://localhost:3000` （SDK 内部会自己加 `/v1beta/...`） |

不论哪一种，都使用同一个 `$GATEWAY_API_KEY` 鉴权。

### 5. 打开 Admin UI

启动网关后访问：

```txt
http://localhost:3000/admin
```

Admin API 使用 `GATEWAY_API_KEY` 鉴权。打开页面后，在右上角填入你的 `GATEWAY_API_KEY` 即可使用管理台。

## 在生产环境部署

```bash
# 新 Clone 或者更新后都要先把 Admin Panel 构建一遍
bun run build:admin

# 启动服务端。可以使用 `pm2` 等工具使其持续运行
bun run start
```
