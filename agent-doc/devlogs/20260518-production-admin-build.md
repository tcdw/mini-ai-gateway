# AI Gateway - 20260518 Production Admin Build

## 背景

之前 `bun run start` 直接跑 `bun run index.ts`，admin panel 通过 Bun 的 HTML import 实时打包 React 源码。这意味着：

- React 运行在 **development mode**，控制台有大量 dev warnings
- JS bundle 未经优化，体积较大
- 每次启动都会重新 bundling

在 homelab 部署时，需要 production-ready 的 build + serve 流程。

项目本身已经配置了 `build:admin` 脚本（`apps/admin/package.json`），通过 `bun build ./index.html --outdir ../../dist/admin` 输出到 `dist/admin/`。但 server 端 `index.ts` 始终从 `./apps/admin/index.html` 导入，从未使用构建产物。

## 主要变更

### 1. 按环境切换 admin handler

在 `index.ts:30` 附近新增 `serveProdAdmin` 函数和 `adminHandler` 条件变量：

```ts
function serveProdAdmin(req: Request): Response {
  const url = new URL(req.url);
  const filePath = url.pathname.replace(/^\/admin\/?/, "") || "index.html";
  if (filePath.includes("..")) return new Response("Forbidden", { status: 403 });
  return new Response(Bun.file(`./dist/admin/${filePath}`));
}

const isProduction = process.env.NODE_ENV === "production";
const adminHandler =
  isProduction && (await Bun.file("./dist/admin/index.html").exists())
    ? serveProdAdmin
    : adminIndex;
```

核心逻辑：

- 当 `NODE_ENV=production` 且 `dist/admin/index.html` 存在 → 走 `serveProdAdmin`，从预构建目录 serve 静态文件
- 否则 fallback 到 dev HTML import（保持 HMR 可用）

所有 admin 路由 `/admin`、`/admin/`、`/admin/*` 统一使用 `adminHandler`。

### 2. `start` 脚本串联 build + serve

`package.json:24` 的 `start` 脚本从：

```json
"start": "bun run index.ts"
```

改为：

```json
"start": "bun run build:admin && NODE_ENV=production bun run index.ts"
```

每次 `bun run start` 会先执行 `bun build` 构建 admin panel，再以 production 模式启动 server。两步通过 `&&` 串联，build 失败则不会启动。

## 验证

```bash
# TypeScript 类型检查——无报错
bunx tsc --noEmit

# 构建 admin panel——3118 modules in 203ms
bun run build:admin
# Output:
#   index-gyxndkg3.js   3.35 MB    (entry point)
#   index.html          389 bytes  (entry point)
#   index-vzh8zvfz.css  5.70 KB    (asset)

# 生产模式启动——serve pre-built HTML，无 on-the-fly bundling
NODE_ENV=production bun run index.ts
# curl http://localhost:3000/admin → 返回 dist/admin/index.html
# curl http://localhost:3000/admin/index-vzh8zvfz.css → 200 OK

# 开发模式——行为不变
bun run index.ts
# Bundled page in 134ms: apps/admin/index.html
```

## 提交

```txt
<待提交>
```
