import { useMutation, useQueryClient } from "@tanstack/react-query";
import { App, Button, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { AdminConfigSnapshot, AdminModelRoute } from "@mini-ai-gateway/core";
import { Link } from "@tanstack/react-router";
import {
  GATEWAY_CONFIG_QUERY_KEY,
  PROTOCOLS,
  PROTOCOL_COLORS,
  PROTOCOL_LABELS,
  removeProviderFromSnapshot,
  reorderProvidersInSnapshot,
  useGatewayConfig,
} from "../helpers/config-helpers";
import { removeMapping, reorderProviders } from "../api/client";
import { ProviderPriorityList } from "../components/ProviderPriorityList";

export function ModelsPage() {
  const { message } = App.useApp();
  const query = useGatewayConfig();
  const queryClient = useQueryClient();
  const reorder = useMutation({
    mutationFn: reorderProviders,
    onMutate: async ({ modelId, protocol, providers: nextOrder }) => {
      await queryClient.cancelQueries({ queryKey: GATEWAY_CONFIG_QUERY_KEY });
      const previous = queryClient.getQueryData<AdminConfigSnapshot>(
        GATEWAY_CONFIG_QUERY_KEY,
      );
      if (previous) {
        queryClient.setQueryData<AdminConfigSnapshot>(
          GATEWAY_CONFIG_QUERY_KEY,
          reorderProvidersInSnapshot(previous, modelId, protocol, nextOrder),
        );
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, context.previous);
      }
      message.error(error.message);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, data);
      message.success("Priority saved");
    },
  });
  const remove = useMutation({
    mutationFn: removeMapping,
    onMutate: async ({ modelId, protocol, provider }) => {
      await queryClient.cancelQueries({ queryKey: GATEWAY_CONFIG_QUERY_KEY });
      const previous = queryClient.getQueryData<AdminConfigSnapshot>(
        GATEWAY_CONFIG_QUERY_KEY,
      );
      if (previous) {
        queryClient.setQueryData<AdminConfigSnapshot>(
          GATEWAY_CONFIG_QUERY_KEY,
          removeProviderFromSnapshot(previous, modelId, protocol, provider),
        );
      }
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, context.previous);
      }
      message.error(error.message);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, data);
      message.success("Mapping removed");
    },
  });

  const isMutating = reorder.isPending || remove.isPending;

  const columns: ColumnsType<AdminModelRoute> = [
    {
      title: "Model",
      dataIndex: "id",
      width: 280,
      fixed: "left",
      render: (id: string) => <Typography.Text copyable>{id}</Typography.Text>,
    },
    ...PROTOCOLS.map<ColumnsType<AdminModelRoute>[number]>((protocol) => ({
      title: PROTOCOL_LABELS[protocol],
      dataIndex: ["protocols", protocol],
      width: 260,
      render: (_, record) => {
        const providers = record.protocols[protocol]?.providers ?? [];
        if (providers.length === 0) {
          return <Typography.Text type="secondary">—</Typography.Text>;
        }
        return (
          <div className="protocol-cell">
            <ProviderPriorityList
              providers={providers}
              primaryColor={PROTOCOL_COLORS[protocol]}
              disabled={isMutating}
              onReorder={(next) =>
                reorder.mutate({
                  modelId: record.id,
                  protocol,
                  providers: next,
                })
              }
              onRemove={(providerName) =>
                remove.mutate({
                  modelId: record.id,
                  protocol,
                  provider: providerName,
                })
              }
            />
          </div>
        );
      },
    })),
    {
      title: "Context",
      width: 100,
      render: (_, record) =>
        record.contextWindow ? `${Math.round(record.contextWindow / 1000)}k` : "-",
    },
    {
      title: "Output",
      width: 100,
      render: (_, record) => record.maxOutputTokens ?? "-",
    },
  ];

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Models</Typography.Title>
          <Typography.Text type="secondary">
            Virtual model routing per protocol — first provider wins, fallback on 429/5xx
          </Typography.Text>
        </div>
        <Button type="primary">
          <Link to="/providers">Scan Provider</Link>
        </Button>
      </div>
      <Table
        rowKey="id"
        loading={query.isLoading}
        columns={columns}
        dataSource={query.data?.models ?? []}
        scroll={{ x: 1200 }}
        pagination={{ pageSize: 12 }}
      />
    </section>
  );
}
