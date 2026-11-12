import { Card, Descriptions, Empty, Space, Statistic, Typography } from 'antd';

export function ResultPage() {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        结果
      </Typography.Title>
      <Card title="能力分">
        <Empty description="还没有跑测结果。跑测完成后这里显示能力分 ± 半宽、各维度分与问题探针。" />
      </Card>
      <Card>
        <Descriptions column={3} size="small">
          <Descriptions.Item label="能力分">
            <Statistic value={0} precision={1} suffix="/ 100" />
          </Descriptions.Item>
          <Descriptions.Item label="格式命中率">
            <Statistic value={0} precision={0} suffix="%" />
          </Descriptions.Item>
          <Descriptions.Item label="稳定性">
            <Statistic value={0} precision={0} suffix="%" />
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </Space>
  );
}
