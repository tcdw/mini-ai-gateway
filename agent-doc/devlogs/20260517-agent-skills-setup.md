# AI Gateway - 20260517 Agent Skills 基础设施搭建日志

## 背景

之前项目里并没有为多种 AI 编码代理（Claude Code、Codex、Gemini CLI）准备统一的 skill 安装入口，每个 agent 各自找各自的配置目录，新人 clone 下来还得手动把 `agent-doc/skills/` 里的内容塞进去，体验非常糟糕。

同时项目里写好的 devlog 模板一直只在脑子里口口相传，没有形成可被 agent 自动加载的 SKILL 文档。

本次改动分两步：

1. 先用 `bash` 脚本把 `skills` / `skills-npm` 两个包跑起来，作为 `prepare` 钩子在 `bun install` 之后自动安装 skill；并补上 `write-devlog` 的 SKILL 文档。
2. 立刻发现 `bash` 脚本在 Windows 上不能直接跑（`mkdir -p`、`> /dev/null`、env 前缀都是 POSIX shell 专属），改写成 Bun 脚本来抹平跨平台差异。

## 主要变更

### 1. 引入 skills / skills-npm 依赖

`package.json:11-13` 新增两个 runtime 依赖：

```json
"dependencies": {
  "@mini-ai-gateway/core": "workspace:*",
  "skills": "^1.5.7",
  "skills-npm": "^1.1.1"
}
```

- `skills` 负责把本地 `agent-doc/skills/` 下的 SKILL 文档分发给指定的 agent（这里指定了 `claude-code codex gemini-cli` 三家）。
- `skills-npm` 负责安装由 npm 包形态分发的第三方 skill。

### 2. 新增 `prepare` 脚本钩子

`package.json:23` 新增 npm 生命周期脚本：

```json
"prepare": "bun run scripts/prepare.ts"
```

`bun install` / `npm install` 完成后会自动触发，无需手动跑额外命令。

### 3. 跨平台的 `scripts/prepare.ts`

最初版本是 `scripts/prepare.sh`，用 `mkdir -p` + `DISABLE_TELEMETRY=1 bun run ... > /dev/null` 这套 POSIX shell 语法。Windows 上：

- `mkdir -p` 不存在
- 环境变量前缀语法 `FOO=bar cmd` 不被 `cmd.exe` 识别
- `> /dev/null` 在 Windows 没有 `/dev/null` 这个设备

改写后的 `scripts/prepare.ts` 用 `Bun.$` 模板字符串 + Node `fs.promises.mkdir({ recursive: true })`：

```ts
import { $ } from "bun";
import { mkdir } from "node:fs/promises";

await Promise.all([
  mkdir(".agents", { recursive: true }),
  mkdir(".claude", { recursive: true }),
]);

console.log("-> Installing agent skills from agent-doc");
await $`bun run skills add ./agent-doc/skills --yes --agent claude-code codex gemini-cli`
  .env({ ...process.env, DISABLE_TELEMETRY: "1" })
  .quiet();

console.log("-> Installing agent skills from npm packages");
await $`bun run skills-npm --yes`.quiet();
```

要点：

- `Bun.$` 自带跨平台 shell，不依赖系统 `bash`。
- `.env({ ...process.env, DISABLE_TELEMETRY: "1" })` 替代 `DISABLE_TELEMETRY=1 cmd` 的前缀写法。
- `.quiet()` 替代 `> /dev/null`，抑制子进程的 stdout / stderr。
- `mkdir({ recursive: true })` 替代 `mkdir -p`。

旧的 `scripts/prepare.sh` 已删除。

### 4. 新增 write-devlog SKILL

`agent-doc/skills/write-devlog/SKILL.md` 把原本散落在脑子里的 devlog 写作规范固化下来：

- 文件名格式 `YYYYMMDD-<kebab-topic>.md`
- 文档骨架（背景 / 主要变更 / 验证 / 提交）
- 必须从 `git log` 取真实 commit hash，从 `git diff` 取真实改动
- 用中文写

frontmatter 的 description 字段会被 agent 用来匹配触发时机，因此明确写了「Use when the user asks to write a devlog, development log, 开发日志, or document a feature/change for this project」。

### 5. `.gitignore` 补充

`.gitignore` 末尾新增：

```
.agents
.claude
skills-lock.json
```

- `.agents` / `.claude` 是 `prepare` 脚本会写入 skill 配置的目录，属于本地产物。
- `skills-lock.json` 是 `skills-npm` 生成的锁文件，目前还没有跨机一致性的诉求，先不入库。

## 验证

```bash
bun run prepare
```

输出：

```
$ bun run scripts/prepare.ts
-> Installing agent skills from agent-doc
-> Installing agent skills from npm packages
```

两个子命令均正常退出，`.agents` / `.claude` 目录被正确创建。

## 提交

```txt
ca9789d feat: setup ai infra
<pending> chore: rewrite prepare script in bun for cross-platform support
```
