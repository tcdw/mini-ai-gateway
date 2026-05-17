# AI Gateway - 20260514 开发日志

## 目标

移除负载均衡和会话保持，简化为顺序回退（Sequential Fallback）。作为个人 AI Gateway，多 Provider 均衡路由没有实际收益，反而增加了复杂度和 Prompt Cache 的不确定性。

## 变更详情

### 1. 移除负载均衡 (`index.ts`)

- 删除 `ModelProvider.weight` 字段
- 删除 `weightedRandom()` 权重随机选择函数
- Provider 选择从加权随机 → 直接取 `candidates[0]`，配置中的先后顺序即优先级

### 2. 移除会话保持 (`index.ts`)

整个 Session Affinity 系统（~80 行）全部砍掉：

- 删除 `SessionPin` 接口、`sessionPins` Map
- 删除 `extractSessionId()`、`lookupPin()`、`savePin()` 函数
- 删除 5 分钟间隔的 TTL 清理定时器

### 3. 简化回退逻辑 (`index.ts`)

`handleChatCompletion` 的回退循环保持不变：

```
for each provider in order:
  try → ok? return upstream
  try → 429/5xx? continue to next
  try → 400/401? return error directly
```

只是每次取 `candidates[0]` 而非随机选择。

### 4. 配置清理 (`config.toml`)

- 删除所有 `weight = 5` 行
- 删除 `anthropic/claude-opus-4.7` 下遗留的空 provider 条目

### 5. 附带修复 (`index.ts`)

- 修复 `req.json()` 返回 `unknown` 的 TS 类型错误（`as Record<string, unknown>`）

## 行为变化

| 场景 | 之前 | 现在 |
|------|------|------|
| 同模型多次请求 | 随机选 Provider（有 Session Affinity 锁定） | 总是第一个 Provider |
| Provider 429 | 换下一个 | 换下一个（不变） |
| Provider 500 | 换下一个 | 换下一个（不变） |
| 跨模型请求 | Session ID 可能跨模型锁定 | 各自走各自的第一个 Provider |

## Commits

```
e0f7ba7 refactor: replace load balancing with sequential fallback
```
