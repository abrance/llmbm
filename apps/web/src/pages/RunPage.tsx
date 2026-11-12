import { Alert, Button, Card, Empty, Progress, Space, Typography } from 'antd';
import { loadCheckpoint } from '../lib/store.js';

export function RunPage() {
  const checkpoint = loadCheckpoint();
  const done = checkpoint ? Object.keys(checkpoint.done).length : 0;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        跑测
      </Typography.Title>
      <Alert
        type="warning"
        showIcon
        message="跑测引擎待接入"
        description="题库与判分由 core 提供；本页只搭流程骨架（选组 → 采样 → 断点续跑 → 取消）。引擎接入后此提示移除。"
      />
      <Card title="断点续跑">
        {checkpoint ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              上次运行 {checkpoint.runId}（题库 {checkpoint.questionBankVersion}，seed {checkpoint.seed}），已完成 {done} 题
            </Typography.Text>
            <Progress percent={0} status="normal" />
          </Space>
        ) : (
          <Empty description="本机没有可续跑的记录" />
        )}
      </Card>
      <Space>
        <Button type="primary" disabled>
          开始跑测（待接入）
        </Button>
        <Button disabled>补测</Button>
        <Button danger disabled>
          取消
        </Button>
      </Space>
    </Space>
  );
}
