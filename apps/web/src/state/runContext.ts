/**
 * 跑测上下文（独立模块）：只放 context 与 hook。
 * 独立成文件是为了 HMR：编辑 RunProvider 时页面不会拿到另一份 context。
 */
import { createContext, useContext } from 'react';
import type { JudgeKind } from '@llmbm/core';
import type { StoredEndpoint } from '../lib/store.js';
import type { ProgressState, RunCheckpoint, RunPhase, RunRecord, StartOptions } from '../lib/types.js';

export interface RunContextValue {
  endpoint?: StoredEndpoint;
  run?: RunRecord;
  checkpoint?: RunCheckpoint;
  phase: RunPhase;
  progress: ProgressState;
  startedAtMs?: number;
  error?: string;
  /** ModelTrace 探针正在采集（结果页显示进行中，而不是失败）。 */
  modelTracePending: boolean;
  availableJudges: readonly JudgeKind[];
  bankVersion: string;
  judgeRuleVersion: string;
  saveEndpoint(values: StoredEndpoint): boolean;
  start(options: StartOptions): void;
  resume(): void;
  cancel(): void;
  discardCheckpoint(): void;
  retryFailed(ids?: string[]): void;
  clearRun(): void;
}

export const RunContext = createContext<RunContextValue | undefined>(undefined);

export function useRun(): RunContextValue {
  const value = useContext(RunContext);
  if (!value) throw new Error('useRun 必须在 RunProvider 内使用');
  return value;
}
