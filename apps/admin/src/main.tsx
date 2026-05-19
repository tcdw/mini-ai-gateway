import "antd/dist/reset.css";
import "./style.css";

import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
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
  routeTree: rootRoute.addChildren([
    indexRoute,
    providersRoute,
    clientConfigRoute,
    statsRoute,
  ]),
  basepath: "/admin",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
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
