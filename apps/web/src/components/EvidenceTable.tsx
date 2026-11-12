import { Alert, Button, Collapse, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { groupLabel } from '../data/bank.js';
import type { QuestionResult, RunRecord, SampleResult } from '../lib/types.js';
import { ScoreTag, SectionCard } from './Layout.js';
import { scoreColor } from './Score.js';

function SampleView({ sample }: { sample: SampleResult }) {
  const response = sample.response;
  const checkColumns: ColumnsType<{ name: string; pass: boolean; detail?: string; hard?: boolean }> = [
    { title: '检查项', dataIndex: 'name', width: 260, render: (v: string) => <code>{v}</code> },
    {
      title: '结果',
      dataIndex: 'pass',
      width: 90,
      render: (v: boolean) => (v ? <Tag color="success">通过</Tag> : <Tag color="error">未过</Tag>),
    },
    {
      title: '详情',
      dataIndex: 'detail',
      render: (v: string | undefined) => <Typography.Text type="secondary">{v ?? '—'}</Typography.Text>,
    },
  ];
  return (
    <div className="sample-view">
      {response.error ? <Alert type="error" showIcon message="本次采样失败" description={response.error} style={{ marginBottom: 12 }} /> : null}
      <div className="sample-meta">
        <span>HTTP {response.httpStatus ?? '—'}</span>
        <span>{response.latencyMs ?? '—'} ms</span>
        <span>finish: {response.finishReason ?? '—'}</span>
        <span>行重复率 {(sample.repeatRatio * 100).toFixed(0)}%</span>
        <span>得分 {sample.score.score.toFixed(1)}</span>
      </div>
      <pre className="response-text">{response.text || '（空响应）'}</pre>
      {response.reasoning ? (
        <Collapse
          size="small"
          style={{ marginBottom: 12 }}
          items={[{ key: 'reasoning', label: 'reasoning / thinking', children: <pre className="response-text">{response.reasoning}</pre> }]}
        />
      ) : null}
      {response.toolCalls && response.toolCalls.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text strong>工具调用</Typography.Text>
          <Table
            size="small"
            pagination={false}
            rowKey={(r) => `${r.name}-${r.id ?? ''}`}
            dataSource={response.toolCalls}
            columns={[
              { title: '函数', dataIndex: 'name', width: 180 },
              {
                title: '参数',
                dataIndex: 'rawArguments',
                render: (v: string | undefined, r) => <code>{v ?? JSON.stringify(r.args ?? {})}</code>,
              },
            ]}
          />
        </div>
      ) : null}
      <Table
        size="small"
        pagination={false}
        rowKey="name"
        dataSource={sample.checks}
        columns={checkColumns}
        style={{ marginBottom: 12 }}
      />
      {response.raw !== undefined ? (
        <Collapse
          size="small"
          items={[{ key: 'raw', label: '原始响应 JSON（证据原文）', children: <pre className="response-text raw">{JSON.stringify(response.raw, null, 2)}</pre> }]}
        />
      ) : null}
    </div>
  );
}

export function EvidenceTable({ run, onRetry, busy }: { run: RunRecord; onRetry: (ids: string[]) => void; busy?: boolean }) {
  const columns: ColumnsType<QuestionResult> = [
    {
      title: '题目',
      dataIndex: 'questionId',
      width: 210,
      render: (v: string, r) => (
        <span>
          <code>{v}</code>
          {r.core ? <Tag color="blue" style={{ marginLeft: 6 }}>core</Tag> : null}
        </span>
      ),
    },
    { title: '维度', dataIndex: 'group', width: 100, render: (v: string) => groupLabel(v) },
    { title: '判定', dataIndex: 'judge', width: 130, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: '得分',
      dataIndex: 'mean',
      width: 150,
      render: (v: number, r) => (
        <span style={{ color: scoreColor(v), fontWeight: 600 }}>
          {v.toFixed(1)} <small style={{ fontWeight: 400 }}>± {r.halfWidth.toFixed(1)}</small>
        </span>
      ),
    },
    { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => <ScoreTag status={v} /> },
    {
      title: '',
      width: 80,
      render: (_v, r) => (
        <Button size="small" type="link" disabled={busy || r.status === 'pass'} onClick={() => onRetry([r.questionId])}>
          重试
        </Button>
      ),
    },
  ];

  return (
    <SectionCard title="证据链" hint="每一题 × 每次采样的原文、判定项与耗时都在这里；失败题可单题重试。">
      <Table<QuestionResult>
        rowKey="questionId"
        size="middle"
        dataSource={run.results}
        columns={columns}
        pagination={{ pageSize: 12, showSizeChanger: false }}
        expandable={{
          expandedRowRender: (record) => (
            <Tabs
              size="small"
              items={record.samples.map((sample) => ({
                key: String(sample.index),
                label: `#${sample.index + 1} · ${sample.score.score.toFixed(0)} 分 · ${sample.response.latencyMs ?? '—'}ms`,
                children: <SampleView sample={sample} />,
              }))}
            />
          ),
        }}
      />
    </SectionCard>
  );
}
