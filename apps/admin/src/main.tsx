import "antd/dist/reset.css";
import "./style.css";

import type {
  AdminConfigSnapshot,
  AdminProvider,
  AdminModelRoute,
  ClientConfigKind,
  Protocol,
  ProviderModel,
} from "@mini-ai-gateway/core";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  RouterProvider,
} from "@tanstack/react-router";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  addMapping,
  generateClientConfig,
  getConfig,
  removeMapping,
  removeProviderEndpoint,
  reorderProviders,
  scanProviderModels,
  upsertProviderEndpoint,
} from "./api/client";
import { AppShell } from "./components/AppShell";
import { ProviderPriorityList } from "./components/ProviderPriorityList";
import { useAdminStore } from "./stores/admin-store";

const queryClient = new QueryClient();

const GATEWAY_CONFIG_QUERY_KEY = ["gateway-config"] as const;

const PROTOCOLS = ["openai", "anthropic", "gemini"] as const satisfies readonly Protocol[];
const PROTOCOL_LABELS: Record<Protocol, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
};
const PROTOCOL_COLORS: Record<Protocol, string> = {
  openai: "geekblue",
  anthropic: "purple",
  gemini: "magenta",
};

function useGatewayConfig() {
  const gatewayApiKey = useAdminStore((store) => store.gatewayApiKey);
  const authRevision = useAdminStore((store) => store.authRevision);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    // Refetch whenever the gateway API key changes so a new token immediately
    // pulls fresh data without leaving stale results from the previous key.
    queryClient.invalidateQueries({ queryKey: GATEWAY_CONFIG_QUERY_KEY });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authRevision]);

  return useQuery({
    queryKey: GATEWAY_CONFIG_QUERY_KEY,
    queryFn: getConfig,
    enabled: gatewayApiKey.trim().length > 0,
  });
}

type ScanStatus = "new" | "same-name" | "configured";

interface ScanResultRow extends ProviderModel {
  status: ScanStatus;
  targetCandidates: string[];
}

function getModelShortName(modelId: string) {
  return modelId.includes("/") ? modelId.split("/").pop()! : modelId;
}

function mapModelRoute(
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

function reorderProvidersInSnapshot(
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
    // Preserve any providers not present in nextOrder (defensive).
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

function removeProviderFromSnapshot(
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

function flattenProviders(route: AdminModelRoute): {
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

function ModelsPage() {
  const { message } = App.useApp();
  const query = useGatewayConfig();
  const queryClient = useQueryClient();
  const reorder = useMutation({
    mutationFn: reorderProviders,
    // Optimistic update: immediately reflect the new provider order so the
    // dragged item doesn't flicker back to its original spot while the
    // request is in flight.
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

  // Lock the whole table while any reorder/remove mutation is in flight so we
  // don't race overlapping optimistic updates against each other.
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

interface EndpointModalState {
  provider: string;
  protocol: Protocol;
  baseUrl: string;
  authHeader: string;
}

function ProvidersPage() {
  const { message } = App.useApp();
  const query = useGatewayConfig();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = React.useState("");
  const [scanProtocol, setScanProtocol] = React.useState<Protocol>("openai");
  const [searchTerm, setSearchTerm] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | ScanStatus>(
    "all",
  );
  const [pendingModel, setPendingModel] = React.useState<ScanResultRow | null>(
    null,
  );
  const [targetModelId, setTargetModelId] = React.useState("");
  const [addingModelId, setAddingModelId] = React.useState("");
  const [endpointModal, setEndpointModal] =
    React.useState<EndpointModalState | null>(null);

  const scan = useMutation({
    mutationFn: scanProviderModels,
    onSuccess: () => {
      setSearchTerm("");
      setStatusFilter("all");
      setPendingModel(null);
      message.success("Scan complete");
    },
    onError: (error) => message.error(error.message),
  });

  const add = useMutation({
    mutationFn: addMapping,
    onSuccess: (data) => {
      queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, data);
      setPendingModel(null);
      setAddingModelId("");
      message.success("Mapping added");
    },
    onError: (error) => {
      setAddingModelId("");
      message.error(error.message);
    },
  });

  const upsertEndpoint = useMutation({
    mutationFn: upsertProviderEndpoint,
    onSuccess: (data) => {
      queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, data);
      setEndpointModal(null);
      message.success("Endpoint saved");
    },
    onError: (error) => message.error(error.message),
  });

  const deleteEndpoint = useMutation({
    mutationFn: removeProviderEndpoint,
    onSuccess: (data) => {
      queryClient.setQueryData(GATEWAY_CONFIG_QUERY_KEY, data);
      message.success("Endpoint removed");
    },
    onError: (error) => message.error(error.message),
  });

  const providers = query.data?.providers ?? [];
  const models = query.data?.models ?? [];

  const scannedModels = React.useMemo(
    () => [...(scan.data?.data ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    [scan.data?.data],
  );

  const scannedRows = React.useMemo<ScanResultRow[]>(() => {
    return scannedModels.map((model) => {
      const shortName = getModelShortName(model.id);
      const targetCandidates = models
        .filter((configured) => {
          const protoRoute = configured.protocols[scanProtocol];
          const hasSelectedProvider = protoRoute?.providers.some(
            (provider) => provider.name === selectedProvider,
          );
          return (
            !hasSelectedProvider &&
            (configured.id === model.id ||
              getModelShortName(configured.id) === shortName)
          );
        })
        .map((configured) => configured.id);

      const alreadyConfigured = models.some(
        (configured) =>
          configured.id === model.id &&
          (configured.protocols[scanProtocol]?.providers ?? []).some(
            (provider) => provider.name === selectedProvider,
          ),
      );

      return {
        ...model,
        targetCandidates,
        status: alreadyConfigured
          ? "configured"
          : targetCandidates.length > 0
            ? "same-name"
            : "new",
      };
    });
  }, [models, scannedModels, selectedProvider, scanProtocol]);

  const filteredRows = React.useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return scannedRows.filter((row) => {
      const matchesSearch =
        !term ||
        row.id.toLowerCase().includes(term) ||
        row.owned_by?.toLowerCase().includes(term);
      const matchesStatus = statusFilter === "all" || row.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [scannedRows, searchTerm, statusFilter]);

  function addScannedModel(row: ScanResultRow, targetId = row.id) {
    setAddingModelId(row.id);
    add.mutate({
      targetModelId: targetId,
      provider: selectedProvider,
      protocol: scanProtocol,
      remap: row.id,
    });
  }

  function requestAddScannedModel(row: ScanResultRow) {
    if (row.status === "configured") return;
    if (row.targetCandidates.length > 0) {
      setPendingModel(row);
      setTargetModelId(row.targetCandidates[0]!);
      return;
    }

    addScannedModel(row);
  }

  const scanColumns: ColumnsType<ScanResultRow> = [
    {
      title: "Model",
      dataIndex: "id",
      sorter: (a, b) => a.id.localeCompare(b.id),
      render: (id: string) => <Typography.Text copyable>{id}</Typography.Text>,
    },
    {
      title: "Owner",
      dataIndex: "owned_by",
      width: 160,
      render: (owner?: string) => owner || "-",
    },
    {
      title: "Status",
      width: 150,
      render: (_, record) => {
        if (record.status === "configured") return <Tag color="green">Added</Tag>;
        if (record.status === "same-name") return <Tag color="orange">Same name</Tag>;
        return <Tag color="blue">New</Tag>;
      },
    },
    {
      title: "Action",
      width: 140,
      render: (_, record) => (
        <Button
          type={record.status === "new" ? "primary" : "default"}
          disabled={record.status === "configured"}
          loading={add.isPending && addingModelId === record.id}
          onClick={() => requestAddScannedModel(record)}
        >
          {record.status === "configured"
            ? "Added"
            : record.status === "same-name"
              ? "Choose"
              : "Add"}
        </Button>
      ),
    },
  ];

  const providerProtocolColumns: ColumnsType<AdminProvider> = [
    {
      title: "Provider",
      dataIndex: "name",
      width: 160,
      fixed: "left",
      render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
    },
    {
      title: "API Key Env",
      width: 200,
      render: (_, record) => (
        <Tag color={record.hasApiKey ? "green" : "orange"}>
          {record.keyEnvVar}
        </Tag>
      ),
    },
    ...PROTOCOLS.map<ColumnsType<AdminProvider>[number]>((protocol) => ({
      title: PROTOCOL_LABELS[protocol],
      width: 280,
      render: (_, record) => {
        const endpoint = record.endpoints[protocol];
        if (!endpoint) {
          return (
            <Button
              size="small"
              type="dashed"
              onClick={() =>
                setEndpointModal({
                  provider: record.name,
                  protocol,
                  baseUrl: "",
                  authHeader: "",
                })
              }
            >
              + Configure
            </Button>
          );
        }
        return (
          <Space direction="vertical" size={4} className="full-width">
            <Typography.Text className="endpoint-url" copyable>
              {endpoint.baseUrl}
            </Typography.Text>
            {endpoint.authHeader ? (
              <Tag color="default">auth: {endpoint.authHeader}</Tag>
            ) : null}
            <Space size={6}>
              <Button
                size="small"
                onClick={() =>
                  setEndpointModal({
                    provider: record.name,
                    protocol,
                    baseUrl: endpoint.baseUrl,
                    authHeader: endpoint.authHeader ?? "",
                  })
                }
              >
                Edit
              </Button>
              <Popconfirm
                title={`Remove ${PROTOCOL_LABELS[protocol]} endpoint?`}
                onConfirm={() =>
                  deleteEndpoint.mutate({
                    provider: record.name,
                    protocol,
                  })
                }
              >
                <Button size="small" danger>
                  Remove
                </Button>
              </Popconfirm>
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  setSelectedProvider(record.name);
                  setScanProtocol(protocol);
                  scan.mutate({ provider: record.name, protocol });
                }}
              >
                Scan
              </Button>
            </Space>
          </Space>
        );
      },
    })),
  ];

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Providers</Typography.Title>
          <Typography.Text type="secondary">
            Support matrix and upstream scans — one provider can speak multiple protocols
          </Typography.Text>
        </div>
      </div>

      <div className="stats-row">
        <Statistic title="Providers" value={providers.length} />
        <Statistic title="Configured Models" value={models.length} />
        <Statistic title="Scanned Models" value={scannedModels.length} />
      </div>

      <Card title="Support matrix" size="small">
        <Table
          rowKey="name"
          loading={query.isLoading}
          dataSource={providers}
          pagination={false}
          columns={providerProtocolColumns}
          scroll={{ x: 1100 }}
        />
      </Card>

      {selectedProvider ? (
        <Card
          title={`Scan: ${selectedProvider} (${PROTOCOL_LABELS[scanProtocol]})`}
        >
          {scannedModels.length === 0 ? (
            <Empty />
          ) : (
            <Space direction="vertical" className="full-width">
              <div className="scan-toolbar">
                <Input.Search
                  allowClear
                  placeholder="Filter by model or owner"
                  value={searchTerm}
                  onChange={(event) => setSearchTerm(event.target.value)}
                />
                <Select
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { label: "All", value: "all" },
                    { label: "New", value: "new" },
                    { label: "Same name", value: "same-name" },
                    { label: "Added", value: "configured" },
                  ]}
                />
              </div>
              <Table
                rowKey="id"
                size="small"
                columns={scanColumns}
                dataSource={filteredRows}
                pagination={{ pageSize: 12 }}
              />
            </Space>
          )}
        </Card>
      ) : null}

      <Modal
        title="Choose target model"
        open={Boolean(pendingModel)}
        confirmLoading={add.isPending}
        onCancel={() => setPendingModel(null)}
        onOk={() => {
          if (pendingModel && targetModelId) addScannedModel(pendingModel, targetModelId);
        }}
      >
        <Space direction="vertical" className="full-width">
          <Typography.Text>
            {pendingModel?.id} already matches a configured model name. Choose where this
            provider mapping should be added.
          </Typography.Text>
          <Select
            className="full-width"
            value={targetModelId}
            onChange={setTargetModelId}
            options={(pendingModel?.targetCandidates ?? []).map((id) => ({
              label: id,
              value: id,
            }))}
          />
        </Space>
      </Modal>

      <Modal
        title={
          endpointModal
            ? `${endpointModal.provider} → ${PROTOCOL_LABELS[endpointModal.protocol]} endpoint`
            : ""
        }
        open={Boolean(endpointModal)}
        confirmLoading={upsertEndpoint.isPending}
        onCancel={() => setEndpointModal(null)}
        onOk={() => {
          if (!endpointModal) return;
          if (!endpointModal.baseUrl.trim()) return;
          upsertEndpoint.mutate({
            provider: endpointModal.provider,
            protocol: endpointModal.protocol,
            endpoint: {
              baseUrl: endpointModal.baseUrl.trim(),
              ...(endpointModal.authHeader.trim()
                ? { authHeader: endpointModal.authHeader.trim() }
                : {}),
            },
          });
        }}
      >
        <Space direction="vertical" className="full-width">
          <Form layout="vertical">
            <Form.Item label="Base URL" required>
              <Input
                value={endpointModal?.baseUrl ?? ""}
                onChange={(event) =>
                  setEndpointModal((prev) =>
                    prev ? { ...prev, baseUrl: event.target.value } : prev,
                  )
                }
                placeholder="https://example.com/v1"
              />
            </Form.Item>
            <Form.Item
              label="Auth header (optional)"
              tooltip="Leave blank to use the protocol default (Bearer for OpenAI/Anthropic, x-goog-api-key for Gemini). Use 'x-api-key' for Anthropic native, 'x-goog-api-key' for Gemini."
            >
              <Input
                value={endpointModal?.authHeader ?? ""}
                onChange={(event) =>
                  setEndpointModal((prev) =>
                    prev ? { ...prev, authHeader: event.target.value } : prev,
                  )
                }
                placeholder="Bearer | x-api-key | x-goog-api-key"
              />
            </Form.Item>
          </Form>
        </Space>
      </Modal>
    </section>
  );
}

function ClientConfigPage() {
  const { message } = App.useApp();
  const query = useGatewayConfig();
  const [form] = Form.useForm();
  const [text, setText] = React.useState("");
  const [kind, setKind] = React.useState<ClientConfigKind>("opencode");
  const generate = useMutation({
    mutationFn: generateClientConfig,
    onSuccess: (data) => setText(data.text),
    onError: (error) => message.error(error.message),
  });

  React.useEffect(() => {
    const defaultModel = query.data?.models[0]?.id;
    if (defaultModel && !form.getFieldValue("defaultModel")) {
      form.setFieldValue("defaultModel", defaultModel);
    }
  }, [form, query.data?.models]);

  React.useEffect(() => {
    let baseUrl = `${window.location.origin}/v1`;
    if (kind === "claude-code") {
      baseUrl = `${window.location.origin}/anthropic`;
    } else if (kind === "gemini-cli") {
      baseUrl = window.location.origin;
    }
    form.setFieldValue("baseUrl", baseUrl);
  }, [kind, form]);

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Client Config</Typography.Title>
          <Typography.Text type="secondary">Generate snippets for local clients</Typography.Text>
        </div>
      </div>

      <Form
        form={form}
        layout="vertical"
        className="config-form"
        initialValues={{
          kind: "opencode" satisfies ClientConfigKind,
          baseUrl: `${window.location.origin}/v1`,
          apiKeyEnvVar: "GATEWAY_API_KEY",
          defaultModel: query.data?.models[0]?.id,
        }}
        onValuesChange={(changed) => {
          if (changed.kind) setKind(changed.kind as ClientConfigKind);
        }}
        onFinish={(values) => generate.mutate(values)}
      >
        <Form.Item label="Client" name="kind">
          <Select
            options={[
              { label: "opencode", value: "opencode" },
              { label: "OpenAI SDK", value: "openai-sdk" },
              { label: "Claude Code (Anthropic)", value: "claude-code" },
              { label: "Gemini CLI / @google/genai", value: "gemini-cli" },
              { label: "curl", value: "curl" },
            ]}
          />
        </Form.Item>
        <Form.Item label="Base URL" name="baseUrl">
          <Input />
        </Form.Item>
        <Form.Item label="API Key Env Var" name="apiKeyEnvVar">
          <Input />
        </Form.Item>
        <Form.Item label="Default Model" name="defaultModel">
          <Select
            showSearch
            options={(query.data?.models ?? []).map((model) => ({
              label: model.id,
              value: model.id,
            }))}
          />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={generate.isPending}>
          Generate
        </Button>
      </Form>

      <Input.TextArea
        id="generated-client-config"
        name="generatedClientConfig"
        value={text}
        rows={16}
        readOnly
        className="config-output"
      />
    </section>
  );
}

function StatsPage() {
  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Stats</Typography.Title>
          <Typography.Text type="secondary">Request logging will land here after sqlite is added</Typography.Text>
        </div>
      </div>
      <Empty description="Usage stats are scaffolded as a future page" />
    </section>
  );
}

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
  </React.StrictMode>
);
