import type {
  AdminConfigSnapshot,
  AdminModelRoute,
  Protocol,
  ProviderModel,
} from "@mini-ai-gateway/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { getConfig } from "../api/client";
import { useAdminStore } from "../stores/admin-store";

export const GATEWAY_CONFIG_QUERY_KEY = ["gateway-config"] as const;

export const PROTOCOLS = [
  "openai",
  "openai-responses",
  "anthropic",
  "gemini",
] as const satisfies readonly Protocol[];
export const PROTOCOL_LABELS: Record<Protocol, string> = {
  openai: "OpenAI",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic",
  gemini: "Gemini",
};
export const PROTOCOL_COLORS: Record<Protocol, string> = {
  openai: "geekblue",
  "openai-responses": "cyan",
  anthropic: "purple",
  gemini: "magenta",
};

export function useGatewayConfig() {
  const gatewayApiKey = useAdminStore((store) => store.gatewayApiKey);
  const authRevision = useAdminStore((store) => store.authRevision);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    queryClient.invalidateQueries({ queryKey: GATEWAY_CONFIG_QUERY_KEY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authRevision]);

  return useQuery({
    queryKey: GATEWAY_CONFIG_QUERY_KEY,
    queryFn: getConfig,
    enabled: gatewayApiKey.trim().length > 0,
  });
}

export type ScanStatus = "new" | "same-name" | "configured";

export interface ScanResultRow extends ProviderModel {
  status: ScanStatus;
  targetCandidates: string[];
}

export interface EndpointModalState {
  provider: string;
  protocol: Protocol;
  baseUrl: string;
  authHeader: string;
}

export function getModelShortName(modelId: string) {
  return modelId.includes("/") ? modelId.split("/").pop()! : modelId;
}

export function mapModelRoute(
  snapshot: AdminConfigSnapshot,
  modelId: string,
  transform: (route: AdminModelRoute) => AdminModelRoute,
): AdminConfigSnapshot {
  return {
    ...snapshot,
    models: snapshot.models.map((route) =>
      route.id === modelId ? transform(route) : route,
    ),
  };
}

export function reorderProvidersInSnapshot(
  snapshot: AdminConfigSnapshot,
  modelId: string,
  protocol: Protocol,
  nextOrder: string[],
): AdminConfigSnapshot {
  return mapModelRoute(snapshot, modelId, (route) => {
    const protoRoute = route.protocols[protocol];
    if (!protoRoute) return route;
    const byName = new Map(protoRoute.providers.map((p) => [p.name, p]));
    const reordered = nextOrder
      .map((name) => byName.get(name))
      .filter((p): p is (typeof protoRoute.providers)[number] => Boolean(p));
    for (const provider of protoRoute.providers) {
      if (!nextOrder.includes(provider.name)) reordered.push(provider);
    }
    return {
      ...route,
      protocols: {
        ...route.protocols,
        [protocol]: { ...protoRoute, providers: reordered },
      },
    };
  });
}

export function removeProviderFromSnapshot(
  snapshot: AdminConfigSnapshot,
  modelId: string,
  protocol: Protocol,
  providerName: string,
): AdminConfigSnapshot {
  return mapModelRoute(snapshot, modelId, (route) => {
    const protoRoute = route.protocols[protocol];
    if (!protoRoute) return route;
    return {
      ...route,
      protocols: {
        ...route.protocols,
        [protocol]: {
          ...protoRoute,
          providers: protoRoute.providers.filter(
            (provider) => provider.name !== providerName,
          ),
        },
      },
    };
  });
}

export function flattenProviders(route: AdminModelRoute): {
  protocol: Protocol;
  index: number;
  name: string;
  remap: string;
}[] {
  const rows: {
    protocol: Protocol;
    index: number;
    name: string;
    remap: string;
  }[] = [];
  for (const protocol of PROTOCOLS) {
    const providers = route.protocols[protocol]?.providers ?? [];
    providers.forEach((provider, index) => {
      rows.push({ protocol, index, name: provider.name, remap: provider.remap });
    });
  }
  return rows;
}
