/**
 * 「超时与响应时延」分组的可读结论（结果页，与问题探针并列）。
 *
 * 统计口径全部来自 lib/latency.ts 的纯函数；这里只做「题库元数据 → 统计输入」的拼装与展示。
 * 铁律：结论必须是一句人话，不能只给数字表；没跑本组时明说没跑，0 超时也要明说。
 */
import { Alert, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { latencyReportOf } from '../lib/latencyReport.js';
import type { QuestionLatencyReport } from '../lib/latency.js';
import type { QuestionResult } from '../lib/types.js';
import { SectionCard } from './Layout.js';

function ms(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function verdictTag(report: QuestionLatencyReport) {
  switch (report.verdict) {
    case 'all-timeout':
      return <Tag color="error">全部超时</Tag>;
    case 'partial-timeout':
      return <Tag color="warning">部分超时</Tag>;
    case 'slower-than-peers':
      return <Tag color="orange">本题偏慢</Tag>;
    case 'normal':
      return <Tag color="success">正常</Tag>;
    default:
      return <Tag>无采样</Tag>;
  }
}

const columns: ColumnsType<QuestionLatencyReport> = [
  { title: '题目', dataIndex: 'questionId', width: 220, render: (value: string) => <code>{value}</code> },
  {
    title: '超时率',
    width: 120,
    render: (_value, record) => (
      <span>
        {record.timeouts}/{record.samples}（{(record.timeoutRate * 100).toFixed(0)}%）
        {record.otherErrors > 0 ? <small>（另 {record.otherErrors} 次断流）</small> : null}
      </span>
    ),
  },
  { title: 'TTFT p50', width: 95, render: (_v, record) => ms(record.ttft.p50) },
  { title: 'TTFT p95', width: 95, render: (_v, record) => ms(record.ttft.p95) },
  { title: 'TTFT max', width: 95, render: (_v, record) => ms(record.ttft.max) },
  { title: '总耗时 p50', width: 100, render: (_v, record) => ms(record.total.p50) },
  { title: '总耗时 p95', width: 100, render: (_v, record) => ms(record.total.p95) },
  { title: '总耗时 max', width: 100, render: (_v, record) => ms(record.total.max) },
  { title: '预算', width: 90, render: (_v, record) => (record.timeoutMs > 0 ? ms(record.timeoutMs) : '—') },
  { title: '结论', width: 100, render: (_v, record) => verdictTag(record) },
  { title: '说明', dataIndex: 'sentences', render: (value: string[]) => <Typography.Text type="secondary">{value.join(' ')}</Typography.Text> },
];

export function LatencyPanel({ results }: { results: readonly QuestionResult[] }) {
  const report = latencyReportOf(results);
  const ran = report.samples > 0;
  return (
    <SectionCard
      title={`超时与响应时延（${report.samples} 次采样）`}
      hint="把「慢」拆开：首字慢是排队/预热，总时长慢是吞吐或预算不足，中途卡死是流式链路断了。与问题探针并列，不折叠。"
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {report.headlines.map((headline, index) => (
          <Alert
            key={headline}
            type={!ran ? 'info' : report.timeouts > 0 ? 'warning' : 'success'}
            showIcon
            message={headline}
            style={index === 0 ? undefined : { marginTop: -4 }}
          />
        ))}
        {ran ? (
          <Table<QuestionLatencyReport>
            rowKey="questionId"
            size="small"
            pagination={false}
            dataSource={report.questions}
            columns={columns}
            scroll={{ x: 1320 }}
          />
        ) : (
          <Typography.Text type="secondary">本次没有运行「超时与响应时延」分组，无法给出该类结论；下次跑测勾选该分组即可。</Typography.Text>
        )}
        {report.questions.some((question) => question.questionId === 'timeout-concurrency-001') ? (
          <Typography.Text type="secondary">
            并发下的时延放大是人工复核项：当前编排按题串行采样，没有并发测量能力，不把串行数据当并发结论。
          </Typography.Text>
        ) : null}
      </Space>
    </SectionCard>
  );
}
