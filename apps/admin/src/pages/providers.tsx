import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { AdminProvider } from "@mini-ai-gateway/core";
import React from "react";
import {
  GATEWAY_CONFIG_QUERY_KEY,
  getModelShortName,
  PROTOCOLS,
  PROTOCOL_LABELS,
  useGatewayConfig,
} from "../helpers/config-helpers";
import type { EndpointModalState, ScanResultRow } from "../helpers/config-helpers";
import {
  addMapping,
  removeProviderEndpoint,
  scanProviderModels,
  upsertProviderEndpoint,
} from "../api/client";

export function ProvidersPage() {
  const { message } = App.useApp();
  const query = useGatewayConfig();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = React.useState("");
  const [scanProtocol, setScanProtocol] = React.useState<"openai" | "anthropic" | "gemini">("openai");
  const [searchTerm, setSearchTerm] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<"all" | "new" | "same-name" | "configured">(
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
