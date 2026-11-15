import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, SectionCard } from '../components/Layout.js';
import { JUDGE_KINDS } from '@llmbm/core';
import { DEFAULT_GROUPS, GROUP_META, GROUP_ORDER, QUESTION_BANK } from '../data/bank.js';
import { MOCK_AVAILABLE } from '../lib/build.js';
import { etaMs, failedIds, formatDuration, progressPercent } from '../lib/metrics.js';
import { isMockBase } from '../lib/transport.js';
import { useRun } from '../state/runContext.js';

function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function RunPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const {
    endpoint,
    run,
    checkpoint,
    phase,
    progress,
    startedAtMs,
    error,
    availableJudges,
    start,
    resume,
    cancel,
    discardCheckpoint,
    retryFailed,
  } = useRun();

  const [groups, setGroups] = useState<string[]>([...DEFAULT_GROUPS]);
  const [seed, setSeed] = useState(randomSeed);
  const [samples, setSamples] = useState(3);
  const [includeUnavailable, setIncludeUnavailable] = useState(false);
  const [injectFlaky, setInjectFlaky] = useState(false);
  const [now, setNow] = useState(Date.now());
  const prevPhase = useRef(phase);

  useEffect(() => {
    if (phase === 'running' || phase === 'cancelling') {
      const timer = window.setInterval(() => setNow(Date.now()), 1000);
      return () => window.clearInterval(timer);
    }
    return undefined;
  }, [phase]);

  useEffect(() => {
    if (prevPhase.current !== 'done' && phase === 'done') navigate('/result');
    prevPhase.current = phase;
  }, [phase, navigate]);

  const availableSet = useMemo(() => new Set(availableJudges), [availableJudges]);
  const groupStats = useMemo(
    () =>
      GROUP_ORDER.map((key) => {
        const all = QUESTION_BANK.filter((q) => q.group === key);
        const runnable = all.filter((q) => availableSet.has(q.judge));
        return {
          key,
          label: GROUP_META[key]?.label ?? key,
          hint: GROUP_META[key]?.hint ?? '',
          total: all.length,
          runnable: runnable.length,
          missing: [...new Set(all.filter((q) => !availableSet.has(q.judge)).map((q) => q.judge))],
        };
      }),
    [availableSet],
  );
  const planned = groupStats
    .filter((s) => groups.includes(s.key))
    .reduce((sum, s) => sum + (includeUnavailable ? s.total : s.runnable), 0);
  const plannedSamples = planned * samples;
  const busy = phase === 'running' || phase === 'cancelling';
  const elapsedMs = startedAtMs ? Math.max(0, now - startedAtMs) : 0;
  const eta = etaMs(progress.done, progress.total, elapsedMs);
  const isMock = endpoint ? isMockBase(endpoint.baseUrl) : false;
  const failed = run ? failedIds(run.results).length : 0;
  const cpMatches =
    checkpoint && endpoint
      ? checkpoint.endpoint.baseUrl === endpoint.baseUrl.replace(/\/+$/, '') && checkpoint.endpoint.model === endpoint.model
      : false;

  function onStart() {
    if (!endpoint) {
      message.warning('先保存接入配置');
      return;
    }
    if (isMock && !MOCK_AVAILABLE) {
      message.warning('生产环境不包含内置 Mock，请先填真实中转站配置');
      navigate('/connect');
      return;
    }
    if (planned === 0) {
      message.warning('当前筛选没有可跑的题');
      return;
    }
    start({
      groups,
      seed: seed.trim() || randomSeed(),
      samples,
      includeUnavailable,
      injectFlaky,
    });
  }

  if (!endpoint) {
    return (
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <PageHeader
          title="跑测"
          subtitle={
            MOCK_AVAILABLE
              ? '还没有接入配置。先填 Base URL、Key 和模型，或直接用内置 Mock 体验。'
              : '还没有接入配置。先填 Base URL、Key 和模型，保存后即可跑测。'
          }
        />
        <Card variant="borderless" className="panel">
          <Empty description="没有可用的接入配置">
            <Button type="primary" onClick={() => navigate('/connect')}>
              去接入配置
            </Button>
          </Empty>
        </Card>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <PageHeader
        title="跑测"
        subtitle="选分组、固定 seed、每题采样 3 次。跑测在 Web Worker 里执行，切到后台标签页也不会停；刷新页面后用断点继续。"
        extra={
          <Space>
            {run ? (
              <Button onClick={() => navigate('/result')}>查看上次结果</Button>
            ) : null}
            {run && failed > 0 ? (
              <Button onClick={() => retryFailed()} disabled={busy}>
                补测失败题（{failed}）
              </Button>
            ) : null}
          </Space>
        }
      />

      {isMock && !MOCK_AVAILABLE ? (
        <Alert
          type="warning"
          showIcon
          message="当前配置是内置 Mock，但生产环境不包含 Mock 端点"
          description="请回接入配置填真实中转站的 Base URL、Key 和模型后再跑测。"
          action={
            <Button size="small" onClick={() => navigate('/connect')}>
              重新配置
            </Button>
          }
        />
      ) : null}

      {error ? (
        <Alert
          type="error"
          showIcon
          message="跑测没有完成"
          description={error}
          action={
            <Button size="small" onClick={() => navigate('/connect')}>
              检查配置
            </Button>
          }
        />
      ) : null}

      {availableJudges.length < JUDGE_KINDS.length ? (
        <Alert
          type="warning"
          showIcon
          message={`判定规则覆盖 ${availableJudges.length}/${JUDGE_KINDS.length} 类`}
          description={
            <span>
              其余判定由 core 团队合入。默认只跑可判定的题；打开「包含未上线判定」会把它们一起跑，未实现的判定会按硬失败记 0 分，只建议在核对规则时使用。
            </span>
          }
        />
      ) : null}

      <Row gutter={20}>
        <Col xs={24} lg={15}>
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            <SectionCard title="1. 选题组" hint="分组对应不同的产品问题；精选补测适合上线前复核高风险项。">
              <Checkbox.Group value={groups} onChange={(values) => setGroups(values as string[])} style={{ width: '100%' }}>
                <Row gutter={[12, 12]}>
                  {groupStats.map((stat) => {
                    const checked = groups.includes(stat.key);
                    return (
                      <Col xs={24} sm={12} key={stat.key}>
                        <div className={`group-card${checked ? ' is-checked' : ''}`}>
                          <Checkbox value={stat.key} />
                          <div className="group-card-body">
                            <div className="group-card-title">
                              <strong>{stat.label}</strong>
                              <span>
                                {includeUnavailable ? stat.total : stat.runnable}/{stat.total} 题
                              </span>
                            </div>
                            <p>{stat.hint}</p>
                            {stat.missing.length > 0 && !includeUnavailable ? (
                              <small>缺判定：{stat.missing.join('、')}</small>
                            ) : null}
                          </div>
                        </div>
                      </Col>
                    );
                  })}
                </Row>
              </Checkbox.Group>
              <Space style={{ marginTop: 12 }} wrap>
                <Button size="small" onClick={() => setGroups([...GROUP_ORDER])}>
                  全选
                </Button>
                <Button size="small" onClick={() => setGroups(groupStats.filter((s) => s.runnable > 0).map((s) => s.key))}>
                  仅可选可跑
                </Button>
                <Button size="small" onClick={() => setGroups([])}>
                  清空
                </Button>
              </Space>
            </SectionCard>

            <SectionCard title="2. 采样与复现" hint="同一题库 + 同一 seed + 同一规则版本，任何人应得到同一套题。">
              <Row gutter={16}>
                <Col xs={24} md={10}>
                  <label className="field-label">随机种子</label>
                  <Space.Compact style={{ width: '100%' }}>
                    <Input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="留空则随机" spellCheck={false} />
                    <Button onClick={() => setSeed(randomSeed())}>换一个</Button>
                  </Space.Compact>
                </Col>
                <Col xs={12} md={7}>
                  <label className="field-label">每题采样次数</label>
                  <Select
                    style={{ width: '100%' }}
                    value={samples}
                    onChange={setSamples}
                    options={[
                      { label: '1 次（快，无区间）', value: 1 },
                      { label: '3 次（默认，有区间）', value: 3 },
                      { label: '5 次（更稳，慢）', value: 5 },
                    ]}
                  />
                </Col>
                <Col xs={12} md={7}>
                  <label className="field-label">运行选项</label>
                  <div className="switch-row">
                    <Switch checked={includeUnavailable} onChange={setIncludeUnavailable} size="small" />
                    <span>包含未上线判定</span>
                  </div>
                  {isMock && MOCK_AVAILABLE ? (
                    <div className="switch-row">
                      <Switch checked={injectFlaky} onChange={setInjectFlaky} size="small" />
                      <span>故障注入（演示探针）</span>
                    </div>
                  ) : null}
                </Col>
              </Row>
            </SectionCard>

            {checkpoint && !busy ? (
              <SectionCard
                title="发现断点"
                hint="上次没跑完的进度保存在本机 IndexedDB；换模型或换 seed 时会失效。"
                extra={
                  <Space>
                    <Button type="primary" onClick={resume} disabled={busy || !cpMatches}>
                      继续上次
                    </Button>
                    <Button onClick={discardCheckpoint} disabled={busy}>
                      丢弃
                    </Button>
                  </Space>
                }
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Typography.Text>
                    <code>{checkpoint.runId}</code> · {Object.keys(checkpoint.done).length}/{checkpoint.expected} 题 · seed{' '}
                    <code>{checkpoint.seed}</code> · {checkpoint.samples} 次采样
                  </Typography.Text>
                  <Typography.Text type="secondary">
                    模型 {checkpoint.endpoint.model} · 更新于 {new Date(checkpoint.updatedAt).toLocaleString('zh-CN')}
                  </Typography.Text>
                  {!cpMatches ? <Typography.Text type="danger">当前接入配置与断点不一致，先切回原模型再继续。</Typography.Text> : null}
                </Space>
              </SectionCard>
            ) : null}
          </Space>
        </Col>

        <Col xs={24} lg={9}>
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            <Card variant="borderless" className="panel">
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                本次计划
              </Typography.Title>
              <div className="plan-row">
                <span>套题</span>
                <strong>{planned} 题</strong>
              </div>
              <div className="plan-row">
                <span>请求</span>
                <strong>{plannedSamples} 次</strong>
              </div>
              <div className="plan-row">
                <span>按 0.8s/次粗估</span>
                <strong>≈ {formatDuration(plannedSamples * 800)}</strong>
              </div>
              <div className="plan-row">
                <span>模型</span>
                <strong>
                  {endpoint.model} <Tag>{endpoint.protocol ?? 'openai'}</Tag>
                </strong>
              </div>
              <div className="plan-row">
                <span>端点</span>
                <strong>
                  {isMock
                    ? MOCK_AVAILABLE
                      ? '内置 Mock（本地）'
                      : '内置 Mock（生产不可用）'
                    : endpoint.baseUrl.replace(/^https?:\/\//, '').split('/')[0]}
                </strong>
              </div>
              <Button type="primary" block size="large" onClick={onStart} disabled={busy || planned === 0} style={{ marginTop: 16 }}>
                {busy ? '跑测中…' : '开始跑测'}
              </Button>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '10px 0 0' }}>
                {availableJudges.length}/{JUDGE_KINDS.length} 类判定可用，题库版本 {QUESTION_BANK.length} 题。
              </Typography.Paragraph>
            </Card>

            {busy ? (
              <Card variant="borderless" className="panel">
                <Typography.Title level={5} style={{ marginTop: 0 }}>
                  实时进度
                </Typography.Title>
                <Progress
                  percent={Number(progressPercent(progress.done, progress.total).toFixed(1))}
                  status={phase === 'cancelling' ? 'exception' : 'active'}
                />
                <Row gutter={12}>
                  <Col span={12}>
                    <Statistic title="已完成" value={progress.done} suffix={`/ ${progress.total}`} />
                  </Col>
                  <Col span={12}>
                    <Statistic title="已耗时" value={formatDuration(elapsedMs)} />
                  </Col>
                  <Col span={12} style={{ marginTop: 12 }}>
                    <Statistic title="预估剩余" value={eta === undefined ? '—' : formatDuration(eta)} />
                  </Col>
                  <Col span={12} style={{ marginTop: 12 }}>
                    <Statistic title="当前采样" value={`${Math.min(progress.sampleIndex + 1, progress.samples)}/${progress.samples}`} />
                  </Col>
                </Row>
                <div className="current-question">
                  {phase === 'cancelling' ? '正在取消，等待当前请求 abort…' : <>当前：<code>{progress.questionId ?? '准备中'}</code></>}
                </div>
                <Button danger block onClick={cancel} disabled={phase !== 'running'}>
                  取消跑测（真 abort）
                </Button>
              </Card>
            ) : null}
          </Space>
        </Col>
      </Row>
    </Space>
  );
}
