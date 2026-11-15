/**
 * 题库入口（wof 维护）。JSON 是唯一事实源：packages/core/src/data/questions.json。
 * 新增题目只改 JSON；本文件只做类型收窄与分组元数据，不含判定逻辑（D2）。
 */
import type { JudgeKind, Question } from '@llmbm/core';
import raw from '../../../../packages/core/src/data/questions.json' with { type: 'json' };

export interface MockReply {
  text?: string;
  toolCalls?: { name: string; arguments: string }[];
  /** 演示端点回写的 finish_reason（max-tokens 类题要 length 才算通过）。 */
  finishReason?: string;
}

/** 题库条目：spec §2.2 的字段 + 仅供演示端点使用的 mock / tools。 */
export interface BankQuestion extends Question {
  judge: JudgeKind;
  mock?: MockReply;
}

interface BankFile {
  version: string;
  description: string;
  questions: BankQuestion[];
}

const bank = raw as unknown as BankFile;

export const QUESTION_BANK: readonly BankQuestion[] = bank.questions;
export const BANK_VERSION = bank.version;

export interface GroupMeta {
  label: string;
  hint: string;
  /** 该组要回答的产品问题。 */
  goal: string;
}

export const GROUP_ORDER = ['basic', 'ability', 'adversarial', 'endurance', 'advanced', 'spotlight', 'context', 'timeout'] as const;

/** 默认勾选分组：timeout 组只做传输观测（不评分）且单题预算长，默认不跑，由用户显式勾选。 */
export const DEFAULT_GROUPS: string[] = GROUP_ORDER.filter((group) => group !== 'timeout');

export const GROUP_META: Record<string, GroupMeta> = {
  basic: {
    label: '基础',
    hint: '指令遵循、常识、精确输出',
    goal: '确认模型听得懂、答得出，是最低门槛。',
  },
  ability: {
    label: '能力',
    hint: '结构化输出、知识、算术、长文本',
    goal: '区分「能聊」和「能干事」，覆盖真实业务最常用的能力。',
  },
  adversarial: {
    label: '对抗',
    hint: '负向约束、拒答、自洽、引用',
    goal: '看模型会不会被诱导、会不会自相矛盾、会不会编造来源。',
  },
  endurance: {
    label: '耐久',
    hint: '长文本、重复率、格式稳定',
    goal: '连续输出时是否退化、复读，决定它能不能承担长任务。',
  },
  advanced: {
    label: '进阶',
    hint: '工具调用、参数、SVG、嵌套结构',
    goal: '验证 Agent 场景的关键能力：工具选择与参数正确性。',
  },
  spotlight: {
    label: '精选补测',
    hint: '高风险项二次抽检',
    goal: '对拒答、工具参数、SVG 等高风险项做小样本复核，适合上线前补测。',
  },
  context: {
    label: '上下文与参数',
    hint: '多轮、长输入、max_tokens、工具回填、图片、误杀',
    goal: '抓「单轮能答、多轮就崩」的端点：丢 system、丢历史、假长上下文、忽略参数、丢图片。',
  },
  timeout: {
    label: '超时与响应时延',
    hint: '只做传输观测，不计入能力分',
    goal: '把「慢」拆成可归因的几类：是这题太重，还是整个端点在排队；是首字慢，还是总时长超预算。',
  },
};

export function groupLabel(group: string): string {
  return GROUP_META[group]?.label ?? group;
}

export function questionsOfGroup(group: string): BankQuestion[] {
  return QUESTION_BANK.filter((q) => q.group === group);
}
