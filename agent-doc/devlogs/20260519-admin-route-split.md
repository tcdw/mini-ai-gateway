# AI Gateway - 20260519 Admin 主文件按路由拆分解耦

## 背景

`apps/admin/src/main.tsx` 自 admin web UI 上线后持续膨胀，单文件超过 900 行，把所有页面组件、共享常量、类型定义、路由配置、入口渲染全部堆在一起。随着页面增加和逻辑变复杂，维护成本越来越高——改一个页面要在一大坨代码里定位，共享工具函数散落在文件中没有明确的归属。

本次重构将 `main.tsx` 按路由维度拆分为独立页面文件，同时将共享的常量、类型和工具函数提取到 helper 模块，让 `main.tsx` 回归到纯粹的入口文件（路由配置 + 渲染）。

## 主要变更

### 1. 提取共享 helpers → `helpers/config-helpers.ts`

将原来散落在 `main.tsx` 里的以下内容迁移到 `apps/admin/src/helpers/config-helpers.ts`：

- **常量**：`GATEWAY_CONFIG_QUERY_KEY`、`PROTOCOLS`、`PROTOCOL_LABELS`、`PROTOCOL_COLORS`
- **类型**：`ScanStatus`、`ScanResultRow`、`EndpointModalState`
- **Hook**：`useGatewayConfig()`
- **工具函数**：`getModelShortName()`、`mapModelRoute()`、`reorderProvidersInSnapshot()`、`removeProviderFromSnapshot()`、`flattenProviders()`

```ts
// apps/admin/src/helpers/config-helpers.ts
import type { AdminConfigSnapshot, AdminModelRoute, Protocol, ProviderModel } from "@mini-ai-gateway/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { getConfig } from "../api/client";
import { useAdminStore } from "../stores/admin-store";

export const GATEWAY_CONFIG_QUERY_KEY = ["gateway-config"] as const;

export const PROTOCOLS = ["openai", "anthropic", "gemini"] as const satisfies readonly Protocol[];
export const PROTOCOL_LABELS: Record<Protocol, string> = { /* ... */ };
export const PROTOCOL_COLORS: Record<Protocol, string> = { /* ... */ };

export function useGatewayConfig() {
  const gatewayApiKey = useAdminStore((store) => store.gatewayApiKey);
  const authRevision = useAdminStore((store) => store.authRevision);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    queryClient.invalidateQueries({ queryKey: GATEWAY_CONFIG_QUERY_KEY });
  }, [authRevision]);

  return useQuery({
    queryKey: GATEWAY_CONFIG_QUERY_KEY,
    queryFn: getConfig,
    enabled: gatewayApiKey.trim().length > 0,
  });
}
```

共 143 行，单一职责——只暴露 admin 各页面共用的配置相关常量和工具。

### 2. 按路由拆分为四个页面文件

每个页面对应一个 `<Route>` 组件，独立到 `pages/` 目录下：

| 路由 | 文件 | 行数 |
|---|---|---|
| `/` | `pages/models.tsx` | 155 |
| `/providers` | `pages/providers.tsx` | 459 |
| `/client-config` | `pages/client-config.tsx` | 102 |
| `/stats` | `pages/stats.tsx` | 15 |

每个页面文件只 import 自己需要的 API 函数和 helpers，例如 `ModelsPage` 只引 `removeMapping` / `reorderProviders`，`ProvidersPage` 只引 `addMapping` / `scanProviderModels` / `upsertProviderEndpoint` / `removeProviderEndpoint`。

```ts
// apps/admin/src/pages/models.tsx (导入示例)
import { removeMapping, reorderProviders } from "../api/client";
import {
  GATEWAY_CONFIG_QUERY_KEY,
  PROTOCOLS,
  PROTOCOL_COLORS,
  PROTOCOL_LABELS,
  removeProviderFromSnapshot,
  reorderProvidersInSnapshot,
  useGatewayConfig,
} from "../helpers/config-helpers";
import { ProviderPriorityList } from "../components/ProviderPriorityList";
```

Provider 页面额外使用了 `import type { EndpointModalState, ScanResultRow }` 以满足 `verbatimModuleSyntax` 约束。

### 3. `main.tsx` 瘦身为纯入口

现在的 `main.tsx` 只做三件事：

```ts
import "antd/dist/reset.css";
import "./style.css";

import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "antd";
import React from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell";
import { ModelsPage } from "./pages/models";
import { ProvidersPage } from "./pages/providers";
import { ClientConfigPage } from "./pages/client-config";
import { StatsPage } from "./pages/stats";

const queryClient = new QueryClient();

const rootRoute = createRootRoute({ component: AppShell });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: ModelsPage });
const providersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/providers", component: ProvidersPage });
const clientConfigRoute = createRoute({ getParentRoute: () => rootRoute, path: "/client-config", component: ClientConfigPage });
const statsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/stats", component: StatsPage });

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, providersRoute, clientConfigRoute, statsRoute]),
  basepath: "/admin",
});

declare module "@tanstack/react-router" {
  interface Register { router: typeof router; }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App>
        <RouterProvider router={router} />
      </App>
    </QueryClientProvider>
  </React.StrictMode>,
);
```

从 907 行缩减到约 50 行。新增一个页面只需要在 `pages/` 下加文件 + 在 `main.tsx` 加一条 import 和 route，不再需要在同一个文件里翻找。

## 验证

```bash
bunx --bun tsc --noEmit
```

输出为空，类型检查通过，无错误。

```bash
git diff HEAD~1 --stat
```

```
 apps/admin/src/helpers/config-helpers.ts | 143 +++++
 apps/admin/src/main.tsx                  | 869 +------------------------------
 apps/admin/src/pages/client-config.tsx   | 102 ++++
 apps/admin/src/pages/models.tsx          | 155 ++++++
 apps/admin/src/pages/providers.tsx       | 459 ++++++++++++++++
 apps/admin/src/pages/stats.tsx           |  15 +
 6 files changed, 881 insertions(+), 862 deletions(-)
```

变更纯粹是结构重组（+881 / -862），无行为改动。

## 提交

```txt
2bd38e3 refactor(admin): split main.tsx into route-based pages and shared helpers
```
