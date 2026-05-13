# AI Gateway — Phase 1 开发日志

## 核心理念

一个纯转发的 OpenAI Compatible API 网关，将多个 AI Provider（OpenRouter、Vercel AI Gateway、AiHubMix、DeepSeek 等）整合为统一入口。客户端只看到 `openai/gpt-5.5`、`google/gemini-3.1-pro-preview` 这样的虚拟模型 ID，不知道背后真实路由到哪个 Provider。

## 技术栈

- **运行时**: Bun（零外部依赖，仅 `@types/bun`）
- **配置**: TOML（`config.toml`）
- **数据同步**: models.dev API → `models-meta.json`

## 已实现功能

### 1. 核心转发 (`index.ts`)

| 功能 | 说明 |
|------|------|
| 认证 | `GATEWAY_API_KEY` 拦截，401 未授权 |
| 路由 | `POST /v1/chat/completions` ↔ Provider |
| 加权负载均衡 | 根据 `weight` 随机分配 |
| 模型名 Remap | 不同 Provider 的模型名自动映射 |
| 流式透传 | SSE 流直接 `return fetch()` 原样返回 |
| 失败回退 | 5xx/429/网络错误 → 自动切换到下一个 Provider |
| 文件清单 | `.env` / `config.toml` / `index.ts` |

### 2. 模型列表 (`GET /v1/models`)

- 读取 `config.toml` 中所有模型，返回 OpenAI 标准格式
- 自动附加 `context_window` / `max_output_tokens` 来自 `models-meta.json`
- 优雅降级：元数据文件缺失也正常返回

### 3. 模型元数据同步 (`scripts/sync-models.ts`)

```bash
bun run scripts/sync-models.ts
```

- 从 `models.dev/api.json`（122 个 Provider、4500+ 模型）拉取
- 自动匹配 `config.toml` 中的模型 → 写入 `models-meta.json`
- 增量策略：已同步的模型自动跳过
- 匹配算法：优先精确 ID → Provider remap 名 → 短名

### 4. HTTP 请求日志

```
[Gateway] POST /v1/chat/completions → 200 (312ms)
[Gateway] GET /v1/models → 200 (0ms)
[Affinity] Session pinned → openrouter (openai/gpt-5.5)
```

每条请求打印 `METHOD PATH → STATUS (耗时)`。

### 5. 会话保持 (Session Affinity)

**问题**：不同 Provider 的 Prompt Cache 不通用，每次随机切换都会产生全额 Input 费用。

**方案演进**：

| 阶段 | 方案 | 问题 |
|------|------|------|
| v1 | 基于 `Bun.hash(seed)` 的一致性哈希 | 换模型立即断连，无状态 |
| v2 | 内存 Map + 10 分钟 TTL | 跨模型保持 pinning ✓ |

**最终实现**：

- **Session ID 提取**（按优先级）：
  1. `body.user` 字段（行业标准后门）
  2. 第一条非 system 消息内容（隐式特征）
- **路由逻辑**：
  1. 查 Map 是否有 pin 记录
  2. 校验 pin 的 Provider 是否在当前模型的候选列表中
  3. 是 → 强行绑定；否 → 加权随机选新 Provider 并写入 Map
- **TTL 清理**：每 5 分钟清除 10 分钟未访问的条目，匹配上游 Cache 生命周期
- **回退保护**：Fallback 成功后自动更新 pin 到新 Provider

### 6. 配置迁移：JSON → TOML

- `config.json` → `config.toml`
- Bun 原生支持 TOML 导入，无需额外的 import attributes
- 可读性大幅提升
