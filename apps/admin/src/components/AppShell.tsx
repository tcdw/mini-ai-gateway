import {
  ApiOutlined,
  BarChartOutlined,
  CodeOutlined,
  DatabaseOutlined,
  LockOutlined,
} from "@ant-design/icons";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Button, ConfigProvider, Input, Layout, Menu, Result, Space, Typography, theme } from "antd";
import { useAdminStore } from "../stores/admin-store";

const { Header, Sider, Content } = Layout;

const navItems = [
  { key: "/", icon: <DatabaseOutlined />, label: <Link to="/">Models</Link> },
  { key: "/providers", icon: <ApiOutlined />, label: <Link to="/providers">Providers</Link> },
  { key: "/client-config", icon: <CodeOutlined />, label: <Link to="/client-config">Client Config</Link> },
  { key: "/stats", icon: <BarChartOutlined />, label: <Link to="/stats">Stats</Link> },
];

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const gatewayApiKey = useAdminStore((store) => store.gatewayApiKey);
  const gatewayApiKeyInput = useAdminStore((store) => store.gatewayApiKeyInput);
  const setGatewayApiKeyInput = useAdminStore((store) => store.setGatewayApiKeyInput);
  const applyGatewayApiKey = useAdminStore((store) => store.applyGatewayApiKey);
  const hasGatewayApiKey = gatewayApiKey.trim().length > 0;
  const hasPendingGatewayApiKey = gatewayApiKeyInput.trim() !== gatewayApiKey;

  return (
    <ConfigProvider
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: "#395f8f",
          borderRadius: 6,
          fontSize: 13,
        },
        components: {
          Layout: { headerBg: "#ffffff", siderBg: "#111827" },
          Table: { cellPaddingBlock: 8, cellPaddingInline: 10 },
        },
      }}
    >
      <Layout className="app-layout">
        <Sider width={232} className="app-sider">
          <div className="brand">
            <div className="brand-mark">AI</div>
            <div>
              <Typography.Text className="brand-title">Mini Gateway</Typography.Text>
              <Typography.Text className="brand-subtitle">Admin Console</Typography.Text>
            </div>
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[pathname]}
            items={navItems}
          />
        </Sider>
        <Layout>
          <Header className="app-header">
            <Space>
              <Typography.Text strong>Gateway API Key</Typography.Text>
              <Input
                id="gateway-api-key"
                name="gatewayApiKey"
                value={gatewayApiKeyInput}
                onChange={(event) => setGatewayApiKeyInput(event.target.value)}
                placeholder="GATEWAY_API_KEY"
                autoComplete="off"
                className="token-input"
              />
              <Button
                type={hasPendingGatewayApiKey ? "primary" : "default"}
                onClick={applyGatewayApiKey}
              >
                Refresh
              </Button>
            </Space>
          </Header>
          <Content className="app-content">
            {hasGatewayApiKey ? (
              <Outlet />
            ) : (
              <Result
                icon={<LockOutlined />}
                title="Gateway API Key Required"
                subTitle="Enter GATEWAY_API_KEY in the header before using the admin console."
              />
            )}
          </Content>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
