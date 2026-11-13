/**
 * F9 家族指纹 / F10 退化 —— 弱信号的展示。
 * 铁律：数值与 core 给的 caveat 必须同屏；verdict 只描述「与基线是否偏离」，
 * 不写成「已确认降智」这类结论；没有基线时明确说「无法判断是否变化」。
 */
import { Alert, Card, Col, Row, Space, Statistic, Tag, Typography } from 'antd';
import type { DegradationSummary, ModelFingerprint } from '@llmbm/core';
import { verdictText } from '../lib/signals.js';
import type { RunRecord } from '../lib/types.js';

function percent(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function verdictTag(verdict: ModelFingerprint['verdict']) {
  if (verdict === 'suspect-degraded') return <Tag color="orange">与基线有偏离</Tag>;
  if (verdict === 'no-anomaly') return <Tag color="green">未见明显偏离</Tag>;
  return <Tag>缺少基线</Tag>;
}

function FingerprintBlock({ fingerprint }: { fingerprint: ModelFingerprint }) {
  const f = fingerprint.features;
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap align="center">
        {verdictTag(fingerprint.verdict)}
        <Typography.Text type="secondary">置信 {percent(fingerprint.confidence)}（仅表示这条信号自身的确定性，不是降智概率）</Typography.Text>
      </Space>
      <Typography.Text>{verdictText(fingerprint.verdict)}</Typography.Text>
      <Row gutter={[16, 12]}>
        <Col xs={12} sm={8} md={5}>
          <Statistic title="平均正文" value={f.meanChars} suffix="字" />
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Statistic title="reasoning 占比" value={f.reasoningShare * 100} precision={0} suffix="%" />
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Statistic title="工具调用率" value={f.toolCallRate * 100} precision={0} suffix="%" />
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Statistic title="拒答率" value={f.refusalRate * 100} precision={0} suffix="%" />
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic title="参与采样" value={f.samples} suffix="条" />
        </Col>
      </Row>
      {fingerprint.basis.length > 0 ? (
        <ul className="notice-list">
          {fingerprint.basis.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {fingerprint.deviations.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message="与基线相比的偏离项"
          description={
            <ul className="notice-list">
              {fingerprint.deviations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          }
        />
      ) : null}
      <Typography.Text type="secondary">{fingerprint.caveat}</Typography.Text>
    </Space>
  );
}

function DegradationBlock({ degradation }: { degradation: DegradationSummary }) {
  const worst = degradation.worst;
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Tag color={degradation.flagged > 0 ? 'orange' : 'green'}>
          命中 {degradation.flagged}/{degradation.samples} 条采样
        </Tag>
        <Typography.Text type="secondary">置信 {percent(degradation.confidence)}</Typography.Text>
      </Space>
      {degradation.basis.length > 0 ? (
        <ul className="notice-list">
          {degradation.basis.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : null}
      {worst ? (
        <Typography.Text type="secondary">
          最可疑一条：重复行 {percent(worst.repeatRatio)}、长度萎缩 {percent(worst.lengthCollapse)}、
          {worst.tailLoop ? '末尾有复读尾巴' : '末尾未见复读'}。
        </Typography.Text>
      ) : null}
      <Typography.Text type="secondary">{degradation.caveat}</Typography.Text>
    </Space>
  );
}

export function SignalsPanel({ run }: { run: RunRecord }) {
  const fingerprint = run.fingerprint;
  const degradation = run.degradation;
  const missing = !fingerprint && !degradation;
  return (
    <Card variant="borderless" className="panel">
      <div className="section-head">
        <div>
          <h3>家族指纹（弱信号）</h3>
          <p>只用本次响应的形态特征，不联网、不调模型；没有同一端点的历史基线就不下结论。</p>
        </div>
      </div>
      {missing ? (
        <Typography.Text type="secondary">本次未采集（这是旧记录，没有指纹与退化数据）。</Typography.Text>
      ) : (
        <Space direction="vertical" size={20} style={{ width: '100%' }}>
          {fingerprint ? <FingerprintBlock fingerprint={fingerprint} /> : <Typography.Text type="secondary">指纹：本次未采集。</Typography.Text>}
          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              退化信号
            </Typography.Title>
            {degradation ? (
              <DegradationBlock degradation={degradation} />
            ) : (
              <Typography.Text type="secondary">退化：本次未采集。</Typography.Text>
            )}
          </div>
        </Space>
      )}
    </Card>
  );
}
