# AI Gateway - 20260516 Admin Web UI 开发日志

## 目标

为 mini-ai-gateway 增加一个本地 Admin Web UI，让模型路由维护从“编辑 TOML + 跑脚本”逐步迁移到可视化操作。

这次迭代围绕四个核心场景展开：

- 扫描上游 Provider 的模型列表
- 添加模型 mapping
- 调整同一个虚拟模型下的 Provider 优先级
- 生成 opencode / OpenAI SDK / curl 等客户端配置

同时，这个 UI 也为后续“用量统计”功能预留了入口。

## 技术选型

### 1. Bun workspace

项目从单包结构扩展为 Bun workspace：

```txt
mini-ai-gateway/
  apps/
    admin/
  packages/
    core/
```

根 `package.json` 新增：

- `workspaces`: `apps/*`、`packages/*`
- `@mini-ai-gateway/core`: workspace 依赖
- `dev:admin`: 启动 Admin 开发服务
- `build:admin`: 构建 Admin CSR app

### 2. Admin 前端技术栈

Admin app 位于 `apps/admin`，采用 React CSR：

- React 19
- TanStack Router
- TanStack Query
- Zustand
- Ant Design

选择 Ant Design 的原因很现实：这是一个本地 Admin Panel，重点是表格、表单、Modal、Tag、Select、状态反馈这些后台组件，不追求营销页式视觉表现。

### 3. Core 包

新增 `packages/core`，把 CLI、Gateway Server 和 Admin API 都可能复用的逻辑抽出来：

| 文件 | 职责 |
|------|------|
| `config.ts` | 读取 / 写入 `config.toml`、添加 mapping、调整 Provider 顺序 |
| `providers.ts` | 调用 Provider 的 `/models` 接口扫描模型 |
| `client-config.ts` | 生成 opencode / OpenAI SDK / curl 配置 |
| `types.ts` | 共享类型定义 |

这样避免了 TUI 脚本、Gateway API、Web UI 各自复制一套模型扫描和配置写入逻辑。

## Gateway Server 变更

### 1. 挂载 Admin UI

`index.ts` 现在通过 Bun HTML import 挂载：

```ts
import adminIndex from "./apps/admin/index.html";
```

新增路由：

- `GET /admin`
- `GET /admin/`
- `GET /admin/*`

这些路由都返回 Admin CSR app。

### 2. Admin API

新增 `/admin/api/*`：

| API | 方法 | 作用 |
|-----|------|------|
| `/admin/api/config` | GET | 返回 Provider 和模型路由快照 |
| `/admin/api/providers/:provider/models/scan` | POST | 扫描某个 Provider 的模型列表 |
| `/admin/api/models/mappings` | POST | 批量添加 mapping，保留兼容 |
| `/admin/api/models/:modelId/providers` | POST | 单个模型添加 Provider mapping |
| `/admin/api/models/:modelId/providers` | PATCH | 调整 Provider 优先级 |
| `/admin/api/client-config` | POST | 生成客户端配置片段 |

保存配置时会同时：

1. 写回 `config.toml`
2. 更新运行中的内存 `cfg`

因此 Admin UI 保存 mapping 或优先级后，不需要立刻重启 Gateway 才生效。

### 3. 鉴权修复

初版 Admin API 支持可选 `ADMIN_TOKEN`，但未设置时等于无鉴权。这是一个明显安全问题。

最终改为：

- Admin API 强制使用 `GATEWAY_API_KEY`
- 请求必须携带 `Authorization: Bearer $GATEWAY_API_KEY`
- 无 token 或错误 token 返回 `401`

前端也同步改为在右上角输入 `Gateway API Key`。

## Admin UI 页面

### 1. Models

展示当前虚拟模型路由：

- virtual model id
- Provider fallback 顺序
- remap 后的上游模型名
- context window
- max output tokens

每行可以通过 Select 调整 Provider 优先级。配置顺序直接对应 Gateway 的 sequential fallback 顺序。

### 2. Providers

展示 Provider 列表：

- name
- baseUrl
- authHeader
- keyEnvVar
- 当前环境变量是否存在

每个 Provider 可以触发一次 scan。

### 3. Scan Result 交互调整

最初扫描结果是“一大堆 checkbox”，可以多选后一口气添加。实际看起来不够像 Admin Panel，也不利于处理同名模型冲突。

后来改为表格：

- 模型名默认 A-Z 排序
- 支持按 model id / owner 过滤
- 支持状态过滤：`All` / `New` / `Same name` / `Added`
- 每行一个 Add / Choose / Added 按钮
- 暂时不支持批量添加，先保证单个添加行为清晰

### 4. 同名模型冲突处理

当扫描到的模型和现有 virtual model 同名，但当前 Provider 还没有加入该模型时，UI 会弹出 Modal：

- 用户选择要加入哪个现有 virtual model
- 保存时写入 `targetModelId`，`remap` 保留为 Provider 返回的真实模型 ID

这样可以处理“同一个模型在不同 Provider 下返回名称略有差异或短名一致”的情况。

### 5. Client Config

支持生成：

- opencode 配置
- OpenAI SDK 示例
- curl 示例

用户可以选择：

- client 类型
- base URL
- API key env var
- default model

## Gateway API Key 输入行为

前端最初把输入框值直接作为 active key，导致每输入一个字符都会触发 Admin API 请求。

后续改为两层状态：

- `gatewayApiKeyInput`: 输入框草稿
- `gatewayApiKey`: 已生效 key

只有点击 `Refresh` 时才会：

1. 把草稿写入 localStorage
2. 更新 active key
3. 提升 `authRevision`
4. 触发 TanStack Query 重新请求 `/admin/api/config`

无 key 时，页面只显示锁定提示，不会主动请求 Admin API。

## 类型与开发体验修复

### 1. DOM lib

`tsconfig.json` 加入：

```json
"lib": ["ESNext", "DOM", "DOM.Iterable"]
```

以支持 React CSR 里的 `window`、`document` 等 DOM 类型。

### 2. React 类型

Admin workspace 增加：

- `@types/react`
- `@types/react-dom`

### 3. CSS side-effect import

为 `import "./style.css"` 增加声明文件：

```ts
declare module "*.css";
```

文件位于 `apps/admin/src/env.d.ts`。

### 4. `sync-models.ts` 类型修复

`scripts/sync-models.ts` 不再直接 import TOML，而是复用 `@mini-ai-gateway/core` 的 `readGatewayConfig()`，避免 TOML import 被推断为 `unknown` 后造成类型错误。

## 文档更新

README 同步调整：

- 增加本地 Admin UI 特性说明
- 移除“没有复杂 Web UI”的旧 non-goal 描述
- 说明 Admin API 使用 `GATEWAY_API_KEY` 鉴权

## 验证

本次迭代中多次执行：

```bash
bunx tsc --noEmit
bun --filter @mini-ai-gateway/admin build
```

也通过浏览器验证：

- `/admin` 可以渲染
- `/admin/providers` 可以打开
- 无 key 时不请求 Admin API
- 输入 key 时不实时刷新
- 点击 Refresh 后才请求 Admin API
- `/admin/api/config` 无 token 返回 `401`
- `/admin/api/config` 带 `GATEWAY_API_KEY` 返回 `200`

## 后续 TODO

- 用 sqlite 落地请求日志，为 Stats 页面提供数据
- 为 Provider scan 增加更细的错误展示
- 为 `config.toml` 写入保留更多原始格式，减少 serializer 对表头的格式化扰动
- 考虑给 Admin API 增加只监听 localhost 或明确的部署安全说明
- 为 mapping / reorder 增加更小粒度的单元测试

