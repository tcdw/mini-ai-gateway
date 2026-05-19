import { useMutation } from "@tanstack/react-query";
import { App, Button, Form, Input, Select, Typography } from "antd";
import type { ClientConfigKind } from "@mini-ai-gateway/core";
import React from "react";
import { useGatewayConfig } from "../helpers/config-helpers";
import { generateClientConfig } from "../api/client";

export function ClientConfigPage() {
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
