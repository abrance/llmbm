/**
 * 请求消息组装（D1：浏览器端与展示层共用这一份）。
 *
 * 题库里「题目怎么变成一个请求」的规则只有这里一处：
 * 单轮（system + prompt）/ 多轮（messages 原样）/ 长上下文注入（确定性填充 + 针）/
 * 图片（最后一条 user 消息追加 image 分片）。
 *
 * 同一份规则同时产出 `summarizeQuestion` 的展示摘要，保证「界面上写的上下文」
 * 与「实际发出去的请求」是同一个事实源，不会各写一套。
 */
import type { ChatMessage, ContentPart, Question } from './types.js';

/** 长上下文填充行的词表：确定性、与人无关，便于复现同一份输入。 */
const FILLER_TOPICS = [
  '本节记录归档流程的字段约定与校验口径',
  '运维手册要求每轮巡检留存时间戳与执行人',
  '接口约定：错误码必须带业务前缀，禁止裸抛异常',
  '容量规划按峰值 QPS 的 1.5 倍预留，季度复核',
  '变更窗口固定为工作日凌晨，需两人复核',
  '数据保留策略：明细九十天，汇总三年',
  '告警分级：P0 五分钟响应，P1 一小时内',
  '发布流程：灰度百分之十，观察三十分钟再全量',
  '依赖升级需附带回滚脚本与影响面清单',
  '成本口径：按账单日归集，跨部门按调用量分摊',
];

/**
 * 确定性填充文本：同样的 chars 永远生成同一份内容（D4 可复现）。
 * 不引入随机数，避免同 seed 跑出不同输入。
 */
export function fillerText(chars: number): string {
  const target = Math.max(0, Math.floor(chars));
  const lines: string[] = [];
  let size = 0;
  let i = 0;
  while (size < target) {
    const topic = FILLER_TOPICS[i % FILLER_TOPICS.length] as string;
    const line = `第 ${String(i + 1).padStart(5, '0')} 条：${topic}（复核人 ${(i * 7) % 97}，批次 ${(i * 13) % 1009}）。`;
    lines.push(line);
    size += line.length + 1;
    i += 1;
  }
  return lines.join('\n');
}

function contentLength(content: ChatMessage['content']): number {
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 0), 0);
}

/** 把针插进填充文本的 needleAt 位置；返回完整「长文档 + 提问」。 */
export function contextDocText(question: Question): string | undefined {
  const doc = question.contextDoc;
  if (!doc) return undefined;
  const filler = fillerText(doc.fillerChars);
  const at = Math.min(1, Math.max(0, doc.needleAt ?? 0.5));
  if (!doc.needle) return filler;
  const cut = Math.floor(filler.length * at);
  const lineStart = filler.lastIndexOf('\n', cut);
  const pos = lineStart < 0 ? cut : lineStart;
  const needleLine = `第 注 记：本批次归档编号为 ${doc.needle}，仅此一处，不得推断或改写。`;
  return `${filler.slice(0, pos)}\n${needleLine}\n${filler.slice(pos)}`;
}

/** 图片分片追加到最后一条 user 消息（文本在前、图片在后，三家协议都接受）。 */
function withImage(messages: ChatMessage[], question: Question): ChatMessage[] {
  const image = question.image;
  if (!image) return messages;
  const part: ContentPart = { type: 'image', mimeType: image.mimeType, dataBase64: image.dataBase64 };
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as ChatMessage;
    if (msg.role !== 'user') continue;
    const parts: ContentPart[] = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : [...msg.content];
    const out = [...messages];
    out[i] = { ...msg, content: [...parts, part] };
    return out;
  }
  return [...messages, { role: 'user', content: [part] }];
}

/** 长上下文注入：把「长文档 + 提问」拼成最后一条 user 消息。 */
function withContextDoc(messages: ChatMessage[], question: Question): ChatMessage[] {
  const doc = contextDocText(question);
  if (doc === undefined) return messages;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return [...messages, { role: 'user', content: doc }];
  const ask = typeof lastUser.content === 'string' ? lastUser.content : '';
  const content = `下面是一份运维归档文档，请只依据文档内容回答最后的问题。\n\n<文档>\n${doc}\n</文档>\n\n${ask}`;
  return messages.map((m) => (m === lastUser ? { ...m, content } : m));
}

/**
 * 题库条目 → 实际发给模型的消息数组。这是唯一实现：
 * transport（发包）与界面（展示上下文）都必须走这里，禁止各自拼一遍。
 */
export function buildMessages(question: Question): ChatMessage[] {
  const base: ChatMessage[] =
    question.messages && question.messages.length > 0
      ? question.messages.map((m) => ({ ...m }))
      : [...(question.system ? [{ role: 'system' as const, content: question.system }] : []), { role: 'user' as const, content: question.prompt }];
  return withImage(withContextDoc(base, question), question);
}

/** 界面展示用的上下文摘要：题库页「这题怎么发出去的」与证据链里的同一份。 */
export interface QuestionContextSummary {
  /** single-turn = system+prompt；multi-turn = 题库给出完整 messages。 */
  mode: 'single-turn' | 'multi-turn';
  /** 消息条数（含 system / tool）。 */
  turns: number;
  /** 各角色序列，如 ['system','user']。 */
  roles: string[];
  system?: string;
  /** 长文档注入的规模与针。 */
  injection?: { fillerChars: number; needle?: string; needleAt: number; totalChars: number };
  image?: { mimeType: string; bytes: number; alt?: string };
  /** 声明给模型的工具名。 */
  tools?: string[];
  /** 实际发出去的参数（temperature 缺省 0）。 */
  params: { temperature: number; maxTokens?: number };
  timeoutMs: number;
  /** 请求消息的总字符数（不含图片）。 */
  inputChars: number;
}

export function summarizeQuestion(question: Question): QuestionContextSummary {
  const messages = buildMessages(question);
  const roles = messages.map((m) => m.role);
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  // 注入后最后一条 user 文本里含「<文档>」包裹，减去它才是净背景字符数。
  const inputChars = messages.reduce((sum, m) => sum + contentLength(m.content), 0);
  const summary: QuestionContextSummary = {
    mode: question.messages && question.messages.length > 0 ? 'multi-turn' : 'single-turn',
    turns: messages.length,
    roles,
    params: { temperature: question.request?.temperature ?? 0 },
    timeoutMs: question.timeoutMs ?? 30000,
    inputChars,
  };
  if (question.system) summary.system = question.system;
  if (question.contextDoc) {
    summary.injection = {
      fillerChars: question.contextDoc.fillerChars,
      ...(question.contextDoc.needle !== undefined ? { needle: question.contextDoc.needle } : {}),
      needleAt: question.contextDoc.needleAt ?? 0.5,
      totalChars: lastUser ? contentLength(lastUser.content) : 0,
    };
  }
  if (question.image) {
    summary.image = {
      mimeType: question.image.mimeType,
      bytes: Math.floor((question.image.dataBase64.length * 3) / 4),
      ...(question.image.alt !== undefined ? { alt: question.image.alt } : {}),
    };
  }
  if (question.tools && question.tools.length > 0) summary.tools = question.tools.map((t) => t.function.name);
  if (question.request?.maxTokens !== undefined) summary.params.maxTokens = question.request.maxTokens;
  return summary;
}
