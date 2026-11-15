/**
 * F14 超时归因卡片：只统计 response.error 存在的采样，类别由 core 的 classifyTimeout 决定。
 * 无错误时整块不渲染；旧记录（无 report.timeout）显示「本次未采集」。
 */
import { Card, Col, Progress, Row, Space, Tag, Typography } from 'antd';
import { TIMEOUT_CLASSES, TIMEOUT_CLASS_LABEL, timeoutShare } from '../lib/timeoutReport.js';
import type { RunRecord } from '../lib/types.js';

export function TimeoutPanel({ run }: { run: RunRecord }) {
  const report = run.report.timeout;
  if (!report) {
    return (
      <Card variant="borderless" className="panel">
        <div className="section-head">
          <div>
            <h3>超时归因</h3>
            <p>按错误性质区分连接失败、首字前超时、流中途断开、限流与网关错误。</p>
          </div>
        </div>
        <Typography.Text type="secondary">本次未采集（旧记录没有超时归因）。</Typography.Text>
      </Card>
    );
  }
  if (report.samples === 0) return null;

  const top = [...TIMEOUT_CLASSES]
    .sort((a, b) => report.byClass[b] - report.byClass[a])
    .filter((kind) => report.byClass[kind] > 0);
  const byQuestion = new Map<string, number>();
  for (const entry of report.entries) byQuestion.set(entry.questionId, (byQuestion.get(entry.questionId) ?? 0) + 1);

  return (
    <Card variant="borderless" className="panel">
      <div className="section-head">
        <div>
          <h3>超时归因</h3>
          <p>只解释「这次请求为什么没拿到答案」，不参与能力分与 judge 分数。</p>
        </div>
        <Typography.Text type="secondary">
          {report.samples}/{report.requests} 次请求有传输错误
        </Typography.Text>
      </div>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Row gutter={[16, 12]}>
          {TIMEOUT_CLASSES.map((kind) => (
            <Col xs={12} md={8} key={kind}>
              <div className="plan-row">
                <Tag color={kind === 'unknown' ? undefined : 'orange'}>{TIMEOUT_CLASS_LABEL[kind]}</Tag>
                <strong>
                  {report.byClass[kind]} 次 · {(timeoutShare(report, kind) * 100).toFixed(0)}%
                </strong>
              </div>
              <Progress percent={Number((timeoutShare(report, kind) * 100).toFixed(0))} showInfo={false} size="small" />
            </Col>
          ))}
        </Row>
        {top[0] ? (
          <Typography.Text>
            最多的是「{TIMEOUT_CLASS_LABEL[top[0]]}」。
            {top[0] === 'rate-limit' ? '先降并发或换时段，再判断能力分。' : null}
            {top[0] === 'connect' ? '先检查网络、代理与 Base URL 是否可达，以及端点是否迟迟不回响应。' : null}
            {top[0] === 'first-token' ? '端点排队或慢启动，优先看首字延迟而不是总耗时。' : null}
            {top[0] === 'mid-stream' ? '流在完成标记前断掉，网关/中转可能截断了长输出。' : null}
            {top[0] === 'gateway' ? '上游网关错误，多为中转站自身不稳定。' : null}
          </Typography.Text>
        ) : null}
        <div>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            按题分布
          </Typography.Title>
          <Space wrap>
            {[...byQuestion.entries()].map(([questionId, count]) => (
              <Tag key={questionId}>
                {questionId} × {count}
              </Tag>
            ))}
          </Space>
        </div>
        <ul className="notice-list">
          {report.entries.slice(0, 8).map((entry) => (
            <li key={`${entry.questionId}-${entry.sampleIndex}`}>
              <code>{entry.questionId}</code> 采样 #{entry.sampleIndex + 1} · {TIMEOUT_CLASS_LABEL[entry.class]} ·{' '}
              {entry.latencyMs ?? '—'}ms / 超时 {entry.timeoutMs ?? '—'}ms：{entry.error.slice(0, 160)}
            </li>
          ))}
        </ul>
        {report.entries.length > 8 ? (
          <Typography.Text type="secondary">另有 {report.entries.length - 8} 条错误采样，见导出报告。</Typography.Text>
        ) : null}
      </Space>
    </Card>
  );
}
