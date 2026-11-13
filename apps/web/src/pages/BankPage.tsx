/**
 * 题库页：把「一道题测什么」和「它实际发出去的上下文」摆出来。
 *
 * 数据全部来自题库 JSON + core 的 summarizeQuestion/buildMessages，
 * 与跑测时发包用的是同一份实现（D1），不会出现「文档写一套、实发另一套」。
 */
import { Card, Descriptions, Empty, Input, Select, Space, Table, Tag, Typography, Collapse } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { buildMessages, summarizeQuestion, type QuestionContextSummary } from '@llmbm/core';
import { useMemo, useState } from 'react';
import { PageHeader } from '../components/Layout.js';
import { GROUP_META, GROUP_ORDER, QUESTION_BANK, groupLabel, type BankQuestion } from '../data/bank.js';

/** 长文本截断展示；证据链与题库页都怕把 6 万字一次糊到屏幕上。 */
function clip(text: string, n = 320): string {
  return text.length <= n ? text : `${text.slice(0, n)}…（共 ${text.length} 字）`;
}

function ContextSummaryTags({ summary }: { summary: QuestionContextSummary }) {
  return (
    <Space size={[4, 4]} wrap>
      <Tag color={summary.mode === 'multi-turn' ? 'purple' : 'default'}>
        {summary.mode === 'multi-turn' ? `多轮 ${summary.turns} 条` : '单轮'}
      </Tag>
      {summary.system ? <Tag color="geekblue">system</Tag> : null}
      {summary.injection ? (
        <Tag color="orange">注入 {Math.round(summary.injection.fillerChars / 1000)}K 字</Tag>
      ) : null}
      {summary.image ? <Tag color="magenta">图片 {Math.round(summary.image.bytes / 1024)}KB</Tag> : null}
      {summary.tools ? <Tag color="cyan">工具 {summary.tools.length}</Tag> : null}
      {summary.params.maxTokens !== undefined ? <Tag>max_tokens={summary.params.maxTokens}</Tag> : null}
      <Tag>temperature={summary.params.temperature}</Tag>
      <Tag>输入 {summary.inputChars} 字</Tag>
      <Tag>超时 {summary.timeoutMs / 1000}s</Tag>
    </Space>
  );
}

function ContextDetail({ question }: { question: BankQuestion }) {
  const summary = summarizeQuestion(question);
  const messages = buildMessages(question);
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
        <Descriptions.Item label="发送方式">
          {summary.mode === 'multi-turn' ? `题库给出 ${summary.turns} 条完整消息（${summary.roles.join(' → ')}）` : `system（可选）+ 1 条 user`}
        </Descriptions.Item>
        <Descriptions.Item label="参数">
          temperature={summary.params.temperature}
          {summary.params.maxTokens !== undefined ? `，max_tokens=${summary.params.maxTokens}` : ''}
        </Descriptions.Item>
        <Descriptions.Item label="超时">{summary.timeoutMs} ms</Descriptions.Item>
        <Descriptions.Item label="输入规模">{summary.inputChars} 字符（不含图片）</Descriptions.Item>
        {summary.system ? <Descriptions.Item label="system 原文" span={2}>{clip(summary.system)}</Descriptions.Item> : null}
        {summary.injection ? (
          <Descriptions.Item label="长文档注入" span={2}>
            背景约 {summary.injection.fillerChars} 字符，拼在最后一条 user 消息里；针在文档 {Math.round(summary.injection.needleAt * 100)}% 位置
            {summary.injection.needle ? `（针：${summary.injection.needle}）` : '（无针，只看它是否真的读了）'}。实际输入 {summary.injection.totalChars} 字符。
          </Descriptions.Item>
        ) : null}
        {summary.image ? (
          <Descriptions.Item label="图片输入" span={2}>
            {summary.image.mimeType} · {Math.round(summary.image.bytes / 1024)} KB · {summary.image.alt ?? '无说明'}
          </Descriptions.Item>
        ) : null}
        {summary.tools ? (
          <Descriptions.Item label="工具声明" span={2}>
            {summary.tools.map((name) => (
              <Tag key={name}>{name}</Tag>
            ))}
          </Descriptions.Item>
        ) : null}
        <Descriptions.Item label="判定期望" span={2}>
          <code>{JSON.stringify(question.expect ?? null)}</code>
        </Descriptions.Item>
      </Descriptions>
      <Collapse
        size="small"
        items={[
          {
            key: 'messages',
            label: `实际发出的消息（${messages.length} 条）`,
            children: (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {messages.map((m, i) => {
                  const text =
                    typeof m.content === 'string'
                      ? m.content
                      : m.content
                          .map((p) => (p.type === 'text' ? p.text : `［图片 ${p.mimeType} ${Math.round((p.dataBase64.length * 3) / 4 / 1024)}KB］`))
                          .join('\n');
                  return (
                    <div key={i}>
                      <Tag>{m.role}</Tag>
                      {m.tool_calls?.length ? <Tag color="cyan">{m.tool_calls.map((c) => c.function.name).join(', ')}</Tag> : null}
                      <pre className="response-text">{clip(text, 800)}</pre>
                    </div>
                  );
                })}
              </Space>
            ),
          },
        ]}
      />
    </Space>
  );
}

export function BankPage() {
  const [groups, setGroups] = useState<string[]>([...GROUP_ORDER]);
  const [keyword, setKeyword] = useState('');
  const [coreOnly, setCoreOnly] = useState(false);

  const rows = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    return QUESTION_BANK.filter((q) => {
      if (!groups.includes(q.group)) return false;
      if (coreOnly && q.core !== true) return false;
      if (!key) return true;
      const haystack = [q.id, q.prompt, q.description ?? '', ...(q.tags ?? []), q.judge].join(' ').toLowerCase();
      return haystack.includes(key);
    });
  }, [groups, keyword, coreOnly]);

  const columns: ColumnsType<BankQuestion> = [
    {
      title: '题号',
      dataIndex: 'id',
      width: 190,
      render: (v: string, r) => (
        <span>
          <code>{v}</code>
          {r.core ? <Tag color="blue" style={{ marginLeft: 6 }}>core</Tag> : null}
        </span>
      ),
    },
    { title: '分组', dataIndex: 'group', width: 110, render: (v: string) => groupLabel(v) },
    { title: '判定', dataIndex: 'judge', width: 120, render: (v: string) => <Tag>{v}</Tag> },
    {
      title: '这题测什么',
      dataIndex: 'description',
      render: (v: string | undefined) => <Typography.Text>{v ?? '—'}</Typography.Text>,
    },
    {
      title: '实际上下文',
      width: 320,
      render: (_v, r) => <ContextSummaryTags summary={summarizeQuestion(r)} />,
    },
  ];

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <PageHeader
        title="题库与用例"
        subtitle="每道题测的是哪种作假手法，以及它实际发出去的上下文。判分只读响应，这里写的是给人看的用例说明。"
      />

      <Card variant="borderless" className="panel">
        <Space wrap size={12}>
          <Select
            mode="multiple"
            style={{ minWidth: 320 }}
            value={groups}
            onChange={setGroups}
            options={GROUP_ORDER.map((key) => ({
              value: key,
              label: `${GROUP_META[key]?.label ?? key}（${QUESTION_BANK.filter((q) => q.group === key).length}）`,
            }))}
          />
          <Input.Search
            allowClear
            placeholder="按题号、题面、标签、判定筛选"
            style={{ width: 280 }}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Typography.Text type="secondary">
            <a onClick={() => setCoreOnly(!coreOnly)}>{coreOnly ? '只看 core 题（已开启）' : '只看 core 题'}</a>
          </Typography.Text>
          <Typography.Text type="secondary">
            共 {rows.length} 题 / 全库 {QUESTION_BANK.length} 题
          </Typography.Text>
        </Space>
      </Card>

      <Card variant="borderless" className="panel">
        {rows.length === 0 ? (
          <Empty description="当前筛选没有题目" />
        ) : (
          <Table<BankQuestion>
            rowKey="id"
            size="middle"
            dataSource={rows}
            columns={columns}
            pagination={{ pageSize: 12, showSizeChanger: false }}
            expandable={{
              expandedRowRender: (record) => <ContextDetail question={record} />,
            }}
          />
        )}
      </Card>
    </Space>
  );
}
