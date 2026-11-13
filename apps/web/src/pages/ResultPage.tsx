import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Divider,
  Empty,
  Modal,
  Row,
  Space,
  Statistic,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { EvidenceTable } from '../components/EvidenceTable.js';
import { PageHeader } from '../components/Layout.js';
import { ProbePanel } from '../components/ProbePanel.js';
import { IntervalBar, ScoreDial, scoreColor } from '../components/Score.js';
import { groupLabel } from '../data/bank.js';
import { download, exportFilename, exportJson, exportMarkdown } from '../lib/export.js';
import { consistencyOf, failedIds } from '../lib/metrics.js';
import { useRun } from '../state/runContext.js';

export function ResultPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const { run, phase, progress, retryFailed } = useRun();
  const [submitOpen, setSubmitOpen] = useState(false);
  // 参与社区榜单默认不勾选：只有用户主动勾选才会公开提交。
  const [optIn, setOptIn] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedId, setSubmittedId] = useState<string>();
  const [submitError, setSubmitError] = useState<string>();
  const busy = phase === 'running' || phase === 'cancelling';

  if (!run) {
    return (
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <PageHeader title="结果" subtitle="跑测完成后，这里给出能力分 ± 区间、维度分、问题探针和完整证据链。" />
        <Card variant="borderless" className="panel">
          {busy ? (
            <div className="empty-block">
              <Typography.Title level={4}>跑测进行中</Typography.Title>
              <Typography.Paragraph type="secondary">
                已完成 {progress.done}/{progress.total} 题。结果会在跑完后自动出现。
              </Typography.Paragraph>
              <Button onClick={() => navigate('/run')}>回到跑测页</Button>
            </div>
          ) : (
            <Empty description="还没有跑测结果">
              <Button type="primary" onClick={() => navigate('/run')}>
                去跑测
              </Button>
            </Empty>
          )}
        </Card>
      </Space>
    );
  }

  const record = run;
  const report = record.report;
  // 旧断点里没有 D5 的传输字段；缺失时按「无传输失败」展示。
  const transport = report.transport ?? { errors: 0, samples: 0, rate: 0 };
  const sampleCounts = report.samples ?? { valid: 0, total: 0 };
  const transportText = `${transport.errors}/${transport.samples} 次（${(transport.rate * 100).toFixed(1)}%）`;
  const probes = failedIds(record.results);
  const consistency = consistencyOf(record.results);
  const consistencyText = consistency.questions === 0 ? '—' : `${(consistency.rate * 100).toFixed(0)}%`;
  const formatText = report.format.total === 0 ? '—' : `${(report.format.rate * 100).toFixed(1)}%`;

  function onExport(kind: 'md' | 'json') {
    const content = kind === 'json' ? exportJson(record) : exportMarkdown(record);
    const ok = download(exportFilename(record, kind), content, kind === 'json' ? 'application/json' : 'text/markdown');
    if (ok) message.success(`已导出 ${kind.toUpperCase()}`);
    else message.warning('当前环境不支持下载');
  }

  async function onSubmit() {
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      const body = {
        consent: optIn,
        domain: record.endpoint.domain,
        model: record.endpoint.model,
        protocol: record.endpoint.protocol,
        capabilityScore: Number(report.total.mean.toFixed(2)),
        capabilityHalfWidth: Number(report.total.halfWidth.toFixed(2)),
        formatScore: Number((report.format.rate * 100).toFixed(1)),
        stability: Number(report.stability.rate.toFixed(4)),
        questionBankVersion: record.questionBankVersion,
        judgeRuleVersion: record.judgeRuleVersion,
        payload: {
          seed: record.seed,
          samples: record.samples,
          expected: record.expected,
          cancelled: record.cancelled,
          counts: report.counts,
          dimensions: report.dimensions.map((d) => ({ dimension: d.dimension, mean: d.stat.mean, halfWidth: d.stat.halfWidth, questions: d.questions })),
          probes: probes.map((id) => ({ questionId: id })),
        },
      };
      const res = await fetch('/api/community/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.text()).slice(0, 300) || `HTTP ${res.status}`);
      const data = (await res.json()) as { id?: string };
      setSubmittedId(data.id);
      setSubmitOpen(false);
      message.success('已提交社区');
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <PageHeader
        title="结果"
        subtitle="分数按题库版本、规则版本与 seed 可复现；区间来自每题 N 次采样的 t 分布。"
        extra={
          <Space wrap>
            <Button onClick={() => onExport('md')}>导出 Markdown</Button>
            <Button onClick={() => onExport('json')}>导出 JSON</Button>
            <Checkbox
              checked={optIn}
              onChange={(e) => {
                setOptIn(e.target.checked);
                if (!e.target.checked) setSubmitOpen(false);
              }}
            >
              参与社区榜单
            </Checkbox>
            <Button type="primary" onClick={() => setSubmitOpen(true)} disabled={!optIn}>
              提交社区
            </Button>
            {probes.length > 0 ? (
              <Button onClick={() => retryFailed()} disabled={busy}>
                补测失败题（{probes.length}）
              </Button>
            ) : null}
          </Space>
        }
      />

      {submittedId ? (
        <Alert
          type="success"
          showIcon
          message={`已提交社区，记录 ID ${submittedId}`}
          action={
            <Button size="small" onClick={() => navigate('/community')}>
              看榜单
            </Button>
          }
        />
      ) : null}

      {record.cancelled ? (
        <Alert
          type="warning"
          showIcon
          message={
            record.abortReason
              ? `跑测已提前终止，完成 ${report.stability.completed}/${record.expected} 题`
              : `这次跑测被取消，完成 ${report.stability.completed}/${record.expected} 题`
          }
          description={
            record.abortReason
              ? `终止原因：${record.abortReason}。分数只代表已完成的题（未跑的题不进能力分，但完成率会下降）；断点已保存，修好端点后回跑测页点「继续上次」即可续跑。`
              : '分数只代表已完成的题；断点已保存，可以回跑测页继续。'
          }
        />
      ) : null}

      <Alert
        type="info"
        showIcon
        message="区间只反映采样一致性"
        description={`半宽来自同一模型多次采样的离散度，不覆盖题库覆盖度与判定口径差异；temperature=0 下采样可能完全一致，± 0.00 不等于高置信。传输失败 ${transportText}，已从能力分聚合剔除，有效采样 ${sampleCounts.valid}/${sampleCounts.total}。`}
      />

      {report.total.halfWidth > 30 ? (
        <Alert
          type="info"
          showIcon
          message="小样本区间较宽是正常的"
          description={`每题只有 ${record.samples} 次采样，t 分布半宽会被放大；要收窄区间请增加采样次数或补测。`}
        />
      ) : null}

      <Card variant="borderless" className="panel score-hero">
        <Row gutter={24} align="middle">
          <Col xs={24} md={8}>
            <ScoreDial mean={report.total.mean} halfWidth={report.total.halfWidth} n={record.samples} />
          </Col>
          <Col xs={24} md={16}>
            <div className="score-headline">
              <div>
                <Typography.Text type="secondary">被测端点</Typography.Text>
                <Typography.Title level={4} style={{ margin: '2px 0' }}>
                  {record.endpoint.domain}
                </Typography.Title>
              </div>
              <Space wrap>
                <Tag color="blue">{record.endpoint.model}</Tag>
                <Tag>{record.endpoint.protocol}</Tag>
                {!report.capped ? (
                  <Tag color="green">满分未封顶</Tag>
                ) : report.total.mean >= 99 ? (
                  <Tag color="gold">已按 F8 封顶 99</Tag>
                ) : (
                  <Tag>非满分 · 上限 99</Tag>
                )}
                {record.retriedAt ? <Tag>含补测</Tag> : null}
              </Space>
            </div>
            <div className="score-metrics">
              <div>
                <span>格式命中率</span>
                <strong>{formatText}</strong>
                <small>{report.format.hit}/{report.format.total} 题</small>
              </div>
              <div>
                <span>稳定性</span>
                <strong>{(report.stability.rate * 100).toFixed(0)}%</strong>
                <small>{report.stability.completed}/{report.stability.expected} 题完成</small>
              </div>
              <div>
                <span>采样一致率</span>
                <strong>{consistencyText}</strong>
                <small>
                  {consistency.identical}/{consistency.questions} 题多次采样字节一致
                </small>
              </div>
              <div>
                <span>传输错误率</span>
                <strong>{(transport.rate * 100).toFixed(1)}%</strong>
                <small>
                  {transport.errors}/{transport.samples} 次不计入能力分
                </small>
              </div>
              <div>
                <span>通过 / 待复核 / 失败</span>
                <strong>
                  {report.counts.pass} / {report.counts.pending} / {report.counts.fail}
                </strong>
                <small>{report.counts.questions} 题有结果</small>
              </div>
            </div>
            <Divider style={{ margin: '14px 0' }} />
            <Descriptions column={{ xs: 1, sm: 2, md: 3 }} size="small">
              <Descriptions.Item label="题库版本">{record.questionBankVersion}</Descriptions.Item>
              <Descriptions.Item label="规则版本">{record.judgeRuleVersion}</Descriptions.Item>
              <Descriptions.Item label="种子">{record.seed}</Descriptions.Item>
              <Descriptions.Item label="每题采样">{record.samples} 次</Descriptions.Item>
              <Descriptions.Item label="开始时间">{new Date(record.startedAt).toLocaleString('zh-CN')}</Descriptions.Item>
              <Descriptions.Item label="结束时间">
                {record.finishedAt ? new Date(record.finishedAt).toLocaleString('zh-CN') : '—'}
              </Descriptions.Item>
            </Descriptions>
          </Col>
        </Row>
      </Card>

      <Card variant="borderless" className="panel">
        <div className="section-head">
          <div>
            <h3>维度得分</h3>
            <p>按题均值加权；同一维度内题数更多不会自动放大权重。</p>
          </div>
          <Typography.Text type="secondary">
            {report.total.mean.toFixed(2)} ± {report.total.halfWidth.toFixed(2)}（{report.total.n} 题，有效采样 {sampleCounts.valid}/{sampleCounts.total}）
          </Typography.Text>
        </div>
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          {report.dimensions.map((dim) => (
            <div className="dim-row" key={dim.dimension}>
              <div className="dim-name">{groupLabel(dim.dimension)}</div>
              <div className="dim-body">
                <div className="dim-track">
                  <div className="dim-fill" style={{ width: `${dim.stat.mean}%`, background: scoreColor(dim.stat.mean) }} />
                </div>
                <IntervalBar mean={dim.stat.mean} halfWidth={dim.stat.halfWidth} />
              </div>
              <div className="dim-value">
                <strong style={{ color: scoreColor(dim.stat.mean) }}>{dim.stat.mean.toFixed(1)}</strong>
                <span>± {dim.stat.halfWidth.toFixed(1)}</span>
              </div>
              <div className="dim-count">{dim.questions} 题</div>
            </div>
          ))}
        </Space>
      </Card>

      <Row gutter={20}>
        <Col xs={24} md={8}>
          <Card variant="borderless" className="panel stat-card">
            <Statistic title="能力分" value={report.total.mean} precision={1} suffix="/ 100" valueStyle={{ color: scoreColor(report.total.mean) }} />
            <Typography.Text type="secondary">区间 ± {report.total.halfWidth.toFixed(1)}</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card variant="borderless" className="panel stat-card">
            <Statistic title="请求采样" value={report.total.values.length || record.results.reduce((a, r) => a + r.samples.length, 0)} suffix="次" />
            <Typography.Text type="secondary">{record.results.length} 道题 · 有效采样 {sampleCounts.valid}/{sampleCounts.total}</Typography.Text>
          </Card>
        </Col>
        <Col xs={24} md={8}>
          <Card variant="borderless" className="panel stat-card">
            <Statistic title="问题探针" value={probes.length} suffix="项" valueStyle={{ color: probes.length ? '#cf3f3f' : '#1f9d63' }} />
            <Typography.Text type="secondary">非 pass 题按分数升序</Typography.Text>
          </Card>
        </Col>
      </Row>

      <ProbePanel results={record.results} onRetry={(ids) => retryFailed(ids)} busy={busy} />
      <EvidenceTable run={record} onRetry={(ids) => retryFailed(ids)} busy={busy} />

      <Modal
        open={submitOpen}
        title="提交到社区榜单"
        onCancel={() => setSubmitOpen(false)}
        onOk={() => void onSubmit()}
        okText="确认公开并提交"
        cancelText="取消"
        confirmLoading={submitting}
        width={640}
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="提交前请确认公开范围"
          description="社区榜单是公开数据。提交后任何人都能按域名和模型查到这条记录。参与是可选的：勾选框默认不勾选，取消勾选则分数只留在本地、不会上传。"
        />
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="会公开">域名、模型、协议、能力分与区间、格式命中率、稳定性、题库/规则版本、维度分、问题探针题号</Descriptions.Item>
          <Descriptions.Item label="不会上传">API Key、Base URL 路径、请求头、题目原文、模型响应原文、reasoning、工具调用参数</Descriptions.Item>
          <Descriptions.Item label="本次提交">
            {record.endpoint.domain} · {record.endpoint.model} · {report.total.mean.toFixed(1)} ± {report.total.halfWidth.toFixed(1)}
          </Descriptions.Item>
        </Descriptions>
        {submitError ? <Alert type="error" showIcon message="提交失败" description={submitError} style={{ marginTop: 12 }} /> : null}
      </Modal>
    </Space>
  );
}
