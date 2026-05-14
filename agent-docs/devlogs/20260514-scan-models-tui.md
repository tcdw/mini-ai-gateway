# AI Gateway - 20260514 模型扫描 TUI 开发日志

## 目标

新增一个交互式脚本，用来扫描某个 Provider 暴露的全部 OpenAI Compatible 模型，并把选中的模型追加到 `config.toml`。这样添加新模型时不再需要手动打开 Provider 控制台逐个查找模型 ID。

## 使用方式

```bash
bun run scripts/scan-models.ts
```

交互流程：

1. 从 `config.toml` 中选择一个 Provider
2. 调用该 Provider 的 `GET /v1/models`
3. 读取 `models-meta.json` 补充上下文窗口展示信息
4. 在 TUI 中搜索、筛选、勾选想加入的模型
5. 预览即将追加的 TOML 片段
6. 确认后写入 `config.toml`

## 变更详情

### 1. 新增模型扫描脚本 (`scripts/scan-models.ts`)

脚本核心职责：

- 复用 Bun 的 TOML import，直接读取 `config.toml` 中已有 Provider 和模型路由
- 根据选中的 Provider 读取 `baseUrl`、`authHeader`、`keyEnvVar`
- 从环境变量中读取 Provider API Key
- 调用 `${baseUrl}/models` 获取模型列表
- 识别 `config.toml` 中已经配置过的模型和 Provider 组合
- 生成 `[[models."<model-id>".providers]]` TOML 片段并追加到配置末尾

生成格式示例：

```toml
[[models."openai/gpt-5.5".providers]]
name = "openrouter"
remap = "openai/gpt-5.5"
```

`remap` 默认等于 Provider 返回的模型 ID，符合当前配置约定。

### 2. Provider 选择使用轻量 prompt (`@inquirer/prompts`)

新增 dev dependency：

```json
"@inquirer/prompts": "^7"
```

Provider 选择和最终确认仍然用 `@inquirer/prompts`：

- `search()`：从已配置 Provider 中搜索选择
- `confirm()`：写入 `config.toml` 前二次确认，默认值为 No，避免误写

### 3. 模型选择改为手写搜索 TUI

最初尝试使用 `@inquirer/prompts` 的 `checkbox()` 来做多选，并误以为它支持输入过滤。实际运行后发现 checkbox 只能键盘导航、空格勾选，不能真正输入关键词筛选。

最终实现了一个专用 TUI：

| 按键 | 行为 |
|------|------|
| 直接输入 | 追加搜索关键词，实时过滤模型列表 |
| Backspace | 删除搜索关键词 |
| ↑ / ↓ | 移动当前模型光标 |
| Space | 勾选 / 取消当前模型 |
| Ctrl+A | 勾选 / 取消当前过滤结果中的所有可选模型 |
| Enter | 提交选择 |
| Esc | 取消选择 |
| Ctrl+C | 退出脚本 |

TUI 使用 raw mode stdin 和 ANSI escape sequence 实现，不额外引入 TUI 框架。

### 4. 已配置模型检测

脚本会扫描当前配置：

```ts
for (const [modelId, route] of Object.entries(cfg.models)) {
  for (const p of route.providers) {
    if (p.name === selectedProvider) {
      configuredProviderModels.add(modelId);
    }
  }
}
```

行为：

- 已由该 Provider 配置过的模型显示 `✓`
- 已配置项不可再次选择
- 未配置模型排在前面，已配置模型排在后面
- 写入前仍会再次过滤，避免重复写入

### 5. 元数据显示

脚本会读取 `models-meta.json`：

```json
{
  "openai/gpt-5.5": {
    "context_window": 1050000,
    "max_output_tokens": 128000
  }
}
```

如果命中模型 ID，则在选择列表中显示上下文窗口：

```text
openai/gpt-5.5  [1050k ctx]
```

没有元数据时正常降级，只显示模型 ID。

### 6. TOML 安全写入

为了避免特殊字符破坏配置，脚本对 TOML key 和 string value 做了转义：

- model key 中的 `"` 会转义为 `\"`
- `name` / `remap` value 中的 `\` 和 `"` 会转义

写入策略是只追加内容，不重排已有配置：

```ts
const existingContent = await Bun.file(configPath).text();
await Bun.write(configPath, existingContent + tomlBlocks);
```

这样可以最大程度保留手写配置的结构和注释。

## 行为变化

| 场景 | 之前 | 现在 |
|------|------|------|
| 添加 Provider 新模型 | 手动查模型 ID、手写 TOML | 脚本扫描、搜索、勾选、自动追加 |
| 搜索 Provider 模型 | 无 | TUI 实时过滤 |
| 重复添加模型 | 需要人工检查 | 自动标记并禁用已配置项 |
| 上下文窗口信息 | 需要另查 | 命中 `models-meta.json` 时直接展示 |

## 验证

已验证：

- `bun install` 成功安装 `@inquirer/prompts`
- `@inquirer/prompts` 可被 Bun 正常 import
- 非 TTY 环境运行脚本会输出 `This script requires an interactive terminal (TTY).` 并退出，避免卡死
- OpenRouter 的 `/v1/models` 可成功扫描出 363 个模型
- 初版 checkbox 无法搜索的问题已修复为手写搜索 TUI

已知情况：

- `bunx tsc --noEmit` 当前会报 `scripts/sync-models.ts` 中 TOML import 的既有类型问题：`route is of type unknown`，与本次脚本无关

## Commit

```text
9a0db0d feat: add model scan tui
```
