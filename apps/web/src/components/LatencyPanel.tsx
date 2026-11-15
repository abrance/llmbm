/**
 * 「超时与响应时延」分组的可读结论（结果页，与问题探针并列）。
 *
 * 统计口径全部来自 lib/latency.ts（分类与分位数再往下是 core）；这里只做展示。
 * 铁律：结论必须是一句人话，不能只给数字表；没跑本组时明说没跑，0 超时也要明说；
 * 分母必须写清楚（已发起/成功/超时/未发起），不能拿超时当完成时延。
 */
import { Alert, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { latencyReportOf } from '../lib/latencyReport.js';
import type { QuestionLatencyReport } from '../lib/latency.js';
import type { RunRecord } from '../lib/types.js';
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
  { title: '题目', dataIndex: 'questionId', width: 210, render: (value: string) => <code>{value}</code> },
  {
    title: '发起 / 成功 / 超时',
    width: 150,
    render: (_value, record) => (
      <span>
        {record.samples} / {record.samples - record.timeouts - record.otherErrors} / {record.timeouts}
        {record.otherErrors > 0 ? <small>（另 {record.otherErrors} 次非超时失败）</small> : null}
      </span>
    ),
  },
  {
    title: '超时率',
    width: 90,
    render: (_value, record) => (record.samples === 0 ? '—' : `${(record.timeoutRate * 100).toFixed(0)}%`),
  },
  { title: 'TTFT p50', width: 95, render: (_v, record) => ms(record.ttft.p50) },
  { title: 'TTFT p95', width: 95, render: (_v, record) => ms(record.ttft.p95) },
  { title: 'TTFT max', width: 95, render: (_v, record) => ms(record.ttft.max) },
  { title: '总耗时 p50', width: 100, render: (_v, record) => ms(record.total.p50) },
  { title: '总耗时 p95', width: 100, render: (_v, record) => ms(record.total.p95) },
  { title: '总耗时 max', width: 100, render: (_v, record) => ms(record.total.max) },
  { title: '预算', width: 90, render: (_v, record) => (record.timeoutMs > 0 ? ms(record.timeoutMs) : '—') },
  { title: '结论', width: 100, render: (_v, record) => verdictTag(record) },
  {
    title: '说明',
    dataIndex: 'sentences',
    render: (value: string[]) => <Typography.Text type="secondary">{value.join(' ')}</Typography.Text>,
  },
];

export function LatencyPanel({ run }: { run: RunRecord }) {
  const report = latencyReportOf(run);
  const ran = report.initiated > 0;
  const manual = report.questions.filter((question) =>
    (run.results.find((result) => result.questionId === question.questionId)?.tags ?? []).includes('人工复核'),
  );
  return (
    <SectionCard
      title={`超时与响应时延（已发起 ${report.initiated} 次，计划 ${report.expected} 次）`}
      hint="把「慢」拆开：首字慢是排队/预热，总时长慢是吞吐或预算不足，中途卡死是流式链路断了。只做诊断，不进能力分。"
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {report.headlines.map((headline, index) => (
          <Alert
            key={headline}
            type={!ran ? 'info' : report.timedOut > 0 ? 'warning' : 'success'}
            showIcon
            message={headline}
            style={index === 0 ? undefined : { marginTop: -4 }}
          />
        ))}
        {ran ? (
          <>
            <Space size={28} wrap>
              <Statistic title="已发起" value={report.initiated} />
              <Statistic title="成功" value={report.completed} />
              <Statistic title="超时" value={report.timedOut} />
              <Statistic title="其他失败" value={report.failed} />
              <Statistic title="取消" value={report.cancelled} />
              <Statistic title="未发起" value={report.notRun} />
              <Statistic title="超时率" value={(report.timeoutRate * 100).toFixed(1)} suffix="%" />
            </Space>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              超时率分母 = 已发起且非用户取消的采样；p50/p95/max 只统计成功完成的采样，超时不当完成时延。
            </Typography.Text>
            <Table<QuestionLatencyReport>
              rowKey="questionId"
              size="small"
              pagination={false}
              dataSource={report.questions}
              columns={columns}
              scroll={{ x: 1420 }}
            />
          </>
        ) : (
          <Typography.Text type="secondary">
            本次没有运行「超时与响应时延」分组，无法给出该类结论；下次跑测勾选该分组即可。
          </Typography.Text>
        )}
        {manual.length > 0 ? (
          <Typography.Text type="secondary">
            {manual.map((question) => question.questionId).join('、')}{' '}
            标为人工复核项：当前编排按题串行采样，没有并发测量能力， 不把串行数据当并发结论，也不计入能力分。
          </Typography.Text>
        ) : null}
      </Space>
    </SectionCard>
  );
}
