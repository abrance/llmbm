/**
 * ModelTrace 指纹排名卡片（附加结论，不进能力分）。
 * `referenceAccuracy` 必须标注为参考库属性，不能写成「本次 X% 概率是某模型」。
 */
import { Card, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ModelTraceRank } from '@llmbm/core';
import { decisionText, probabilityText, referenceAccuracyText, topProbabilityText } from '../lib/model-trace.js';
import type { RunRecord } from '../lib/types.js';

const columns: ColumnsType<ModelTraceRank> = [
  {
    title: '#',
    width: 48,
    render: (_value, _record, index) => index + 1,
  },
  {
    title: '模型',
    dataIndex: 'display_name',
    render: (value: string, record) => (
      <Space direction="vertical" size={0}>
        <strong>{value}</strong>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {record.model}
        </Typography.Text>
      </Space>
    ),
  },
  { title: '家族', dataIndex: 'family_name', width: 120 },
  { title: 'score', dataIndex: 'score', width: 90, render: (value: number) => value.toFixed(3) },
  { title: '闭集概率', width: 100, render: (_value, record) => probabilityText(record) },
];

export function ModelTraceCard({ run, pending = false }: { run: RunRecord; pending?: boolean }) {
  const result = run.modelTrace;
  return (
    <Card variant="borderless" className="panel">
      <div className="section-head">
        <div>
          <h3>ModelTrace 指纹排名（附加结论，不进能力分）</h3>
          <p>三条独立的整数选择挑战，只回答「这条回答的数字指纹更像参考库里的哪个模型」；不改变能力分与 judge 结论。</p>
        </div>
        {result ? (
          <Tag color={result.decision === 'ranked' ? 'blue' : undefined}>{decisionText(result.decision)}</Tag>
        ) : null}
      </div>
      {!result ? (
        <Typography.Text type="secondary">
          {pending
            ? '探针采集 3 条长请求中…（附加结论，不影响能力分与结果保存）'
            : run.modelTraceRequested
              ? '未取得有效样本（探针失败不影响能力分与结果保存）。'
              : '本次未采集（旧记录没有这一项）。'}
        </Typography.Text>
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Space wrap>
            <Typography.Text>
              有效样本 {result.used}/{result.queries} 条
            </Typography.Text>
            <Typography.Text type="secondary">{topProbabilityText(result)}</Typography.Text>
          </Space>
          {result.ranking.length > 0 ? (
            <Table<ModelTraceRank>
              size="small"
              rowKey="model"
              pagination={false}
              columns={columns}
              dataSource={result.ranking.slice(0, 5)}
            />
          ) : (
            <Typography.Text type="secondary">没有可展示的排名。</Typography.Text>
          )}
          <Typography.Text type="secondary">{referenceAccuracyText(result)}</Typography.Text>
          {result.samples.some((sample) => !sample.accepted) ? (
            <ul className="notice-list">
              {result.samples
                .filter((sample) => !sample.accepted)
                .map((sample) => (
                  <li key={sample.index}>
                    样本 #{sample.index + 1} 未采用：
                    {sample.error ?? `有效整数 ${sample.parsedNumbers}/${sample.minimumNumbers}`}
                  </li>
                ))}
            </ul>
          ) : null}
          <Typography.Text type="secondary">{result.caveat}</Typography.Text>
        </Space>
      )}
    </Card>
  );
}
