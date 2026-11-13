import { Alert, Button, Collapse, Descriptions, Table, Tabs, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { buildMessages, summarizeQuestion, type QuestionContextSummary } from '@llmbm/core';
import { QUESTION_BANK, groupLabel, type BankQuestion } from '../data/bank.js';
import type { QuestionResult, RunRecord, SampleResult } from '../lib/types.js';
import { ScoreTag, SectionCard } from './Layout.js';
import { scoreColor } from './Score.js';

const BANK_BY_ID = new Map<string, BankQuestion>(QUESTION_BANK.map((q) => [q.id, q]));

/** 这道题实际发出去的上下文：与跑测发包共用 core 的同一份组装实现。 */
function QuestionContextBlock({ questionId }: { questionId: string }) {
  const question = BANK_BY_ID.get(questionId);
  if (!question) return null;
  const summary: QuestionContextSummary = summarizeQuestion(question);
  const truncated = buildMessages(question)
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : `［图片 ${p.mimeType}］`)).join('')))
    .join('\n\n');
  return (
    <div className="question-context" style={{ marginBottom: 12 }}>
      {question.description ? (
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          <Typography.Text strong>这题测什么：</Typography.Text>
          {question.description}
        </Typography.Paragraph>
      ) : null}
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
        <Descriptions.Item label="对话">
          {summary.mode === 'multi-turn' ? `多轮 ${summary.turns} 条（${summary.roles.join(' → ')}）` : '单轮'}
        </Descriptions.Item>
        <Descriptions.Item label="参数">
          temperature={summary.params.temperature}
          {summary.params.maxTokens !== undefined ? `，max_tokens=${summary.params.maxTokens}` : ''}
        </Descriptions.Item>
        <Descriptions.Item label="输入规模">{summary.inputChars} 字符</Descriptions.Item>
        <Descriptions.Item label="超时">{summary.timeoutMs} ms</Descriptions.Item>
        {summary.system ? <Descriptions.Item label="system" span={2}>{summary.system}</Descriptions.Item> : null}
        {summary.injection ? (
          <Descriptions.Item label="长文档注入" span={2}>
            背景约 {summary.injection.fillerChars} 字符，针在 {Math.round(summary.injection.needleAt * 100)}% 位置
            {summary.injection.needle ? `（针：${summary.injection.needle}）` : ''}
          </Descriptions.Item>
        ) : null}
        {summary.image ? (
          <Descriptions.Item label="图片" span={2}>
            {summary.image.mimeType} · {Math.round(summary.image.bytes / 1024)} KB · {summary.image.alt ?? '—'}
          </Descriptions.Item>
        ) : null}
        {summary.tools ? (
          <Descriptions.Item label="工具" span={2}>
            {summary.tools.join('、')}
          </Descriptions.Item>
        ) : null}
      </Descriptions>
      <Collapse
        size="small"
        style={{ marginTop: 8 }}
        items={[
          {
            key: 'ctx',
            label: '实际发出的输入（长文档已截断展示）',
            children: <pre className="response-text">{truncated.length > 2000 ? `${truncated.slice(0, 2000)}…（共 ${truncated.length} 字）` : truncated}</pre>,
          },
        ]}
      />
    </div>
  );
}

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
        <span>总耗时 {response.latencyMs ?? '—'} ms</span>
        <span>首字 {response.ttftMs ?? '—'} ms</span>
        <span>{response.tokensPerSec !== undefined ? `${response.tokensPerSec} token/s` : '吞吐 —'}</span>
        <span>分片 {response.chunks ?? '—'}</span>
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
            <>
            <QuestionContextBlock questionId={record.questionId} />
            <Tabs
              size="small"
              items={record.samples.map((sample) => ({
                key: String(sample.index),
                label: `#${sample.index + 1} · ${sample.score.score.toFixed(0)} 分 · ${sample.response.latencyMs ?? '—'}ms`,
                children: <SampleView sample={sample} />,
              }))}
            />
            </>
          ),
        }}
      />
    </SectionCard>
  );
}
