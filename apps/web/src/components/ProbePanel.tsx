import { Button, Empty, Table, Tag } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { groupLabel } from '../data/bank.js';
import { probesOf } from '../lib/metrics.js';
import type { Probe, QuestionResult } from '../lib/types.js';
import { ScoreTag, SectionCard } from './Layout.js';

export function ProbePanel({
  results,
  onRetry,
  busy,
}: {
  results: readonly QuestionResult[];
  onRetry: (ids: string[]) => void;
  busy?: boolean;
}) {
  const probes = probesOf(results);
  const columns: ColumnsType<Probe> = [
    { title: '题目', dataIndex: 'questionId', width: 210, render: (v: string) => <code>{v}</code> },
    { title: '维度', dataIndex: 'group', width: 100, render: (v: string) => groupLabel(v) },
    { title: '判定', dataIndex: 'judge', width: 130, render: (v: string) => <Tag>{v}</Tag> },
    { title: '分数', dataIndex: 'score', width: 80, render: (v: number) => v.toFixed(1) },
    { title: '状态', dataIndex: 'status', width: 100, render: (v: string) => <ScoreTag status={v} /> },
    { title: '问题', dataIndex: 'reason' },
  ];

  return (
    <SectionCard
      title={`问题探针（${probes.length}）`}
      hint="非 pass 的题按分数升序排列。探针只列题号、判定项和原因，完整原文在证据链里。"
      extra={
        probes.length > 0 ? (
          <Button onClick={() => onRetry(probes.map((p) => p.questionId))} disabled={busy}>
            重试全部失败题
          </Button>
        ) : null
      }
    >
      {probes.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有失败或待复核的题" />
      ) : (
        <Table<Probe> rowKey="questionId" size="small" pagination={false} dataSource={probes} columns={columns} />
      )}
    </SectionCard>
  );
}
