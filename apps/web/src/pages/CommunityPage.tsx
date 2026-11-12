import { Card, Empty, Space, Table, Typography } from 'antd';
import { useEffect, useState } from 'react';

interface CommunityRow {
  id: string;
  domain: string;
  model: string;
  protocol: string;
  capabilityScore: number;
  capabilityHalfWidth: number;
  formatScore: number;
  stability: number;
  createdAt: string;
}

export function CommunityPage() {
  const [rows, setRows] = useState<CommunityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/community/results?limit=50')
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { items?: CommunityRow[] };
      })
      .then((json) => {
        if (!cancelled) setRows(json.items ?? []);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        社区
      </Typography.Title>
      {error ? (
        <Card>
          <Empty description={`读取社区结果失败：${error}`} />
        </Card>
      ) : (
        <Card>
          <Table<CommunityRow>
            rowKey="id"
            loading={loading}
            dataSource={rows}
            locale={{ emptyText: '还没有人提交结果' }}
            pagination={{ pageSize: 20 }}
            columns={[
              { title: '域名', dataIndex: 'domain' },
              { title: '模型', dataIndex: 'model' },
              { title: '协议', dataIndex: 'protocol' },
              {
                title: '能力分',
                dataIndex: 'capabilityScore',
                render: (v: number, r) => `${v.toFixed(1)} ± ${r.capabilityHalfWidth.toFixed(1)}`,
              },
              { title: '格式', dataIndex: 'formatScore', render: (v: number) => `${v.toFixed(0)}%` },
              { title: '稳定性', dataIndex: 'stability', render: (v: number) => `${(v * 100).toFixed(0)}%` },
              { title: '提交时间', dataIndex: 'createdAt' },
            ]}
          />
        </Card>
      )}
    </Space>
  );
}
