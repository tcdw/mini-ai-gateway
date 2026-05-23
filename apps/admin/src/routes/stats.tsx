import { createFileRoute } from "@tanstack/react-router";
import { Empty, Typography } from "antd";

export const Route = createFileRoute("/stats")({
  component: StatsPage,
});

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
