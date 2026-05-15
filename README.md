# AI Gateway

一个**极致轻量、专注转发**的私有 OpenAI Compatible API 网关。

专为“自己使用多渠道 API”的场景设计，将散落在各处的 Provider（OpenRouter、Vercel AI Gateway、各种转发 API 站）收拢为一个统一的入口。客户端只需认准统一的虚拟模型 ID（如 `openai/gpt-5.5`），网关会按配置顺序使用第一个可用 Provider，遇 429/5xx 自动回退到下一个。

## ✨ 特性 (Features)

*   **极简核心**：基于 [Bun](https://bun.sh) 原生 HTTP `serve()` 构建，零外部依赖，极速启动与响应。
*   **配置即路由**：使用直观的 TOML 配置文件定义 Provider 与模型映射。
*   **本地 Admin UI**：内置 React 管理台，用于查看模型映射、扫描上游模型、调整 Provider 优先级和生成客户端配置。
*   **元数据同步**：自带爬虫脚本同步 models.dev 元数据，完美支持客户端的 `/v1/models` 容量查询。
*   **原生流式透传**：无缓冲直接透传 SSE 流，不增加首字节延迟（TTFB）。

## 🚫 不做的事情 (Non-Goals)

为了保持项目的轻量与专注，本网关**不会**实现以下功能：

*   **协议转换**：不将 Anthropic、Gemini、Vertex AI 等原生非 OpenAI 协议转为 OpenAI 格式。（推荐让上游诸如 OpenRouter、Vercel 等去做这件事）。
*   **多租户与计费**：没有用户管理、没有 Quota 限制、没有额度统计面板。网关假定只有一个信任的拥有者在使用。
*   **复杂后台系统**：Admin UI 仅面向本地自用，不提供用户管理、审计流、审批流等重型后台能力。

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
AIHUBMIX_API_KEY=sk-ah-...
```

编辑 `config.toml` 定义路由（详见自带配置）。

### 3. 同步元数据 (可选)

如果你需要准确的 `/v1/models` 上下文长度数据：

```bash
bun run scripts/sync-models.ts
```

### 4. 启动网关

```bash
bun run index.ts
```

你的统一 API 地址即为 `http://localhost:3000/v1`，使用 `$GATEWAY_API_KEY` 即可连接任意支持 OpenAI 格式的客户端。

### 5. 打开 Admin UI

启动网关后访问：

```txt
http://localhost:3000/admin
```

Admin API 使用 `GATEWAY_API_KEY` 鉴权。打开页面后，在右上角填入你的 `GATEWAY_API_KEY` 即可使用管理台。
