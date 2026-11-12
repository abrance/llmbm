import { Alert, App, Button, Card, Descriptions, Drawer, Empty, Input, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/Layout.js';
import { groupLabel } from '../data/bank.js';

interface CommunityRow {
  id: string;
  domain: string;
  model: string;
  protocol: string;
  capabilityScore: number;
  capabilityHalfWidth: number;
  formatScore: number;
  stability: number;
  questionBankVersion: string;
  judgeRuleVersion: string;
  createdAt: string;
}

interface Payload {
  seed?: string;
  samples?: number;
  expected?: number;
  cancelled?: boolean;
  counts?: { pass: number; pending: number; fail: number; questions: number };
  dimensions?: { dimension: string; mean: number; halfWidth: number; questions: number }[];
  probes?: { questionId: string }[];
}

interface DetailRow extends CommunityRow {
  payload?: string;
}

export function CommunityPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [rows, setRows] = useState<CommunityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [domain, setDomain] = useState('');
  const [model, setModel] = useState('');
  const [query, setQuery] = useState({ domain: '', model: '' });
  const [detail, setDetail] = useState<DetailRow>();
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (query.domain.trim()) params.set('domain', query.domain.trim());
      if (query.model.trim()) params.set('model', query.model.trim());
      const res = await fetch(`/api/community/results?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { items?: CommunityRow[] };
      setRows(json.items ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDetail(row: CommunityRow) {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/community/results/${row.id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as DetailRow);
    } catch (err) {
      message.error(`读取详情失败：${(err as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  }

  const payload: Payload | undefined = (() => {
    if (!detail?.payload) return undefined;
    try {
      return JSON.parse(detail.payload) as Payload;
    } catch {
      return undefined;
    }
  })();

  const columns: ColumnsType<CommunityRow> = [
    { title: '域名', dataIndex: 'domain', width: 190 },
    { title: '模型', dataIndex: 'model', width: 190 },
    { title: '协议', dataIndex: 'protocol', width: 100, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: '能力分',
      dataIndex: 'capabilityScore',
      width: 150,
      sorter: (a, b) => a.capabilityScore - b.capabilityScore,
      render: (v: number, r) => (
        <strong>
          {v.toFixed(1)} <small>± {r.capabilityHalfWidth.toFixed(1)}</small>
        </strong>
      ),
    },
    { title: '格式', dataIndex: 'formatScore', width: 90, render: (v: number) => `${v.toFixed(0)}%` },
    { title: '稳定性', dataIndex: 'stability', width: 100, render: (v: number) => `${(v * 100).toFixed(0)}%` },
    { title: '题库版本', dataIndex: 'questionBankVersion', width: 140, render: (v: string) => <code>{v}</code> },
    { title: '提交时间', dataIndex: 'createdAt', width: 180, render: (v: string) => new Date(v).toLocaleString('zh-CN') },
  ];

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <PageHeader
        title="社区榜单"
        subtitle="按域名和模型横向对比。榜单只收录分数、区间、维度与题号，不包含任何 Key、题目原文或响应原文。"
        extra={<Button onClick={() => void load()}>刷新</Button>}
      />

      <Card variant="borderless" className="panel">
        <Space wrap style={{ marginBottom: 16 }}>
          <Input placeholder="按域名筛选" value={domain} onChange={(e) => setDomain(e.target.value)} allowClear style={{ width: 220 }} />
          <Input placeholder="按模型筛选" value={model} onChange={(e) => setModel(e.target.value)} allowClear style={{ width: 220 }} />
          <Button type="primary" onClick={() => setQuery({ domain, model })}>
            筛选
          </Button>
          <Button
            onClick={() => {
              setDomain('');
              setModel('');
              setQuery({ domain: '', model: '' });
            }}
          >
            清空
          </Button>
        </Space>

        {error ? (
          <Alert
            type="warning"
            showIcon
            message="社区接口暂时不可用"
            description={
              <span>
                {error}。本地验收时请确认 api 进程已启动（默认 8787，Vite 会代理 /api）。跑测结果仍可正常导出。
              </span>
            }
            action={
              <Button size="small" onClick={() => navigate('/result')}>
                回到结果
              </Button>
            }
          />
        ) : (
          <Table<CommunityRow>
            rowKey="id"
            loading={loading}
            dataSource={rows}
            columns={columns}
            onRow={(record) => ({ onClick: () => void openDetail(record), style: { cursor: 'pointer' } })}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有人提交结果。跑完一次后可在结果页提交。"
                >
                  <Button type="primary" onClick={() => navigate('/result')}>
                    去结果页
                  </Button>
                </Empty>
              ),
            }}
          />
        )}
      </Card>

      <Drawer
        open={Boolean(detail)}
        onClose={() => setDetail(undefined)}
        width={560}
        title={detail ? `${detail.domain} · ${detail.model}` : '提交详情'}
        loading={detailLoading}
      >
        {detail ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="能力分">
                {detail.capabilityScore.toFixed(1)} ± {detail.capabilityHalfWidth.toFixed(1)}
              </Descriptions.Item>
              <Descriptions.Item label="协议">{detail.protocol}</Descriptions.Item>
              <Descriptions.Item label="格式命中率">{detail.formatScore.toFixed(1)}%</Descriptions.Item>
              <Descriptions.Item label="稳定性">{(detail.stability * 100).toFixed(0)}%</Descriptions.Item>
              <Descriptions.Item label="题库版本" span={2}>
                <code>{detail.questionBankVersion}</code>
              </Descriptions.Item>
              <Descriptions.Item label="规则版本" span={2}>
                <code>{detail.judgeRuleVersion}</code>
              </Descriptions.Item>
              <Descriptions.Item label="提交时间" span={2}>
                {new Date(detail.createdAt).toLocaleString('zh-CN')}
              </Descriptions.Item>
            </Descriptions>

            {payload ? (
              <>
                <div>
                  <Typography.Title level={5}>维度分</Typography.Title>
                  <Table
                    size="small"
                    pagination={false}
                    rowKey="dimension"
                    dataSource={payload.dimensions ?? []}
                    columns={[
                      { title: '维度', dataIndex: 'dimension', render: (v: string) => groupLabel(v) },
                      { title: '得分', dataIndex: 'mean', render: (v: number) => v.toFixed(1) },
                      { title: '半宽', dataIndex: 'halfWidth', render: (v: number) => `± ${v.toFixed(1)}` },
                      { title: '题数', dataIndex: 'questions' },
                    ]}
                  />
                </div>
                <div>
                  <Typography.Title level={5}>问题探针（{(payload.probes ?? []).length}）</Typography.Title>
                  {(payload.probes ?? []).length === 0 ? (
                    <Typography.Text type="secondary">没有失败题。</Typography.Text>
                  ) : (
                    <Space wrap>
                      {(payload.probes ?? []).map((p) => (
                        <Tag key={p.questionId}>{p.questionId}</Tag>
                      ))}
                    </Space>
                  )}
                </div>
                <Typography.Text type="secondary">
                  seed {payload.seed ?? '—'} · 每题 {payload.samples ?? '—'} 次采样 · 计划 {payload.expected ?? '—'} 题
                  {payload.cancelled ? ' · 本次被取消' : ''}
                </Typography.Text>
              </>
            ) : (
              <Typography.Text type="secondary">这条记录没有附带维度明细（可能是旧版本提交）。</Typography.Text>
            )}
          </Space>
        ) : null}
      </Drawer>
    </Space>
  );
}
