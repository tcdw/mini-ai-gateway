import "antd/dist/reset.css";
import "./style.css";

import type { ClientConfigKind, ProviderModel } from "@mini-ai-gateway/core";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
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
  reorderProviders,
  scanProviderModels,
} from "./api/client";
import { AppShell } from "./components/AppShell";
import { useAdminStore } from "./stores/admin-store";

const queryClient = new QueryClient();

function useGatewayConfig() {
  const gatewayApiKey = useAdminStore((store) => store.gatewayApiKey);
  const authRevision = useAdminStore((store) => store.authRevision);

  return useQuery({
    queryKey: ["gateway-config", authRevision],
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

function ModelsPage() {
  const { message } = App.useApp();
  const query = useGatewayConfig();
  const queryClient = useQueryClient();
  const reorder = useMutation({
    mutationFn: reorderProviders,
    onSuccess: (data) => {
      queryClient.setQueryData(["gateway-config"], data);
      message.success("Priority saved");
    },
    onError: (error) => message.error(error.message),
  });

  const columns: ColumnsType<NonNullable<typeof query.data>["models"][number]> = [
    {
      title: "Model",
      dataIndex: "id",
      render: (id: string) => <Typography.Text copyable>{id}</Typography.Text>,
    },
    {
      title: "Providers",
      render: (_, record) => (
        <Space wrap>
          {record.providers.map((provider, index) => (
            <Tag key={provider.name} color={index === 0 ? "blue" : "default"}>
              {index + 1}. {provider.name} → {provider.remap}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "Context",
      width: 120,
      render: (_, record) => record.contextWindow ? `${Math.round(record.contextWindow / 1000)}k` : "-",
    },
    {
      title: "Output",
      width: 120,
      render: (_, record) => record.maxOutputTokens ?? "-",
    },
    {
      title: "Priority",
      width: 260,
      render: (_, record) => (
        <Select
          mode="multiple"
          value={record.providers.map((provider) => provider.name)}
          className="priority-select"
          onChange={(providers) => reorder.mutate({ modelId: record.id, providers })}
          options={record.providers.map((provider) => ({
            label: provider.name,
            value: provider.name,
          }))}
        />
      ),
    },
  ];

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Models</Typography.Title>
          <Typography.Text type="secondary">Virtual model routing and fallback priority</Typography.Text>
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
        pagination={{ pageSize: 12 }}
      />
    </section>
  );
}

function ProvidersPage() {
  const { message } = App.useApp();
  const query = useGatewayConfig();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = React.useState("");
  const [searchTerm, setSearchTerm] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | ScanStatus>("all");
  const [pendingModel, setPendingModel] = React.useState<ScanResultRow | null>(null);
  const [targetModelId, setTargetModelId] = React.useState("");
  const [addingModelId, setAddingModelId] = React.useState("");

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
      queryClient.setQueryData(["gateway-config"], data);
      setPendingModel(null);
      setAddingModelId("");
      message.success("Mappings added");
    },
    onError: (error) => {
      setAddingModelId("");
      message.error(error.message);
    },
  });

  const scannedModels = React.useMemo(
    () => [...(scan.data?.data ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    [scan.data?.data]
  );

  const scannedRows = React.useMemo<ScanResultRow[]>(() => {
    const configuredModels = query.data?.models ?? [];

    return scannedModels.map((model) => {
      const shortName = getModelShortName(model.id);
      const targetCandidates = configuredModels
        .filter((configured) => {
          const hasSelectedProvider = configured.providers.some(
            (provider) => provider.name === selectedProvider
          );
          return (
            !hasSelectedProvider &&
            (configured.id === model.id || getModelShortName(configured.id) === shortName)
          );
        })
        .map((configured) => configured.id);

      const alreadyConfigured = configuredModels.some(
        (configured) =>
          configured.id === model.id &&
          configured.providers.some((provider) => provider.name === selectedProvider)
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
  }, [query.data?.models, scannedModels, selectedProvider]);

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

  return (
    <section className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>Providers</Typography.Title>
          <Typography.Text type="secondary">Scan upstream models and append mappings</Typography.Text>
        </div>
      </div>

      <div className="stats-row">
        <Statistic title="Providers" value={query.data?.providers.length ?? 0} />
        <Statistic title="Configured Models" value={query.data?.models.length ?? 0} />
        <Statistic title="Scanned Models" value={scannedModels.length} />
      </div>

      <Table
        rowKey="name"
        loading={query.isLoading}
        dataSource={query.data?.providers ?? []}
        pagination={false}
        columns={[
          { title: "Name", dataIndex: "name" },
          { title: "Base URL", dataIndex: "baseUrl" },
          { title: "Auth", dataIndex: "authHeader", width: 100 },
          {
            title: "API Key",
            width: 180,
            render: (_, record) => (
              <Tag color={record.hasApiKey ? "green" : "orange"}>{record.keyEnvVar}</Tag>
            ),
          },
          {
            title: "Action",
            width: 140,
            render: (_, record) => (
              <Button
                onClick={() => {
                  setSelectedProvider(record.name);
                  scan.mutate(record.name);
                }}
              >
                Scan
              </Button>
            ),
          },
        ]}
      />

      {selectedProvider ? (
        <Card title={`Scan result: ${selectedProvider}`}>
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
    </section>
  );
}

function ClientConfigPage() {
  const { message } = App.useApp();
  const query = useGatewayConfig();
  const [form] = Form.useForm();
  const [text, setText] = React.useState("");
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
        onFinish={(values) => generate.mutate(values)}
      >
        <Form.Item label="Client" name="kind">
          <Select
            options={[
              { label: "opencode", value: "opencode" },
              { label: "OpenAI SDK", value: "openai-sdk" },
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
