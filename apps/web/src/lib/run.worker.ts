/**
 * 跑测 Worker：把「逐题 × 逐采样」的长任务移出主线程，标签页切后台不被节流。
 * 判分、聚合、区间全部调用 @llmbm/core（D1），这里只做调度与事件上报。
 */
import {
  aggregate,
  detectWrapped,
  judge,
  questionStatus,
  sampleStat,
  scoreQuestion,
  type EndpointConfig,
  type QuestionScore,
} from '@llmbm/core';
import type { BankQuestion } from '../data/bank.js';
import { chatOnce } from './transport.js';
import { repeatRatio } from './metrics.js';
import type { QuestionResult, SampleResult, WorkerEvent, WorkerRequest, WorkerStart } from './types.js';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerEvent) => void;
}

const scope = self as unknown as WorkerScope;
const controllers = new Set<AbortController>();
let cancelled = false;

function post(msg: WorkerEvent): void {
  scope.postMessage(msg);
}

function endpointOf(start: WorkerStart): EndpointConfig {
  return {
    baseUrl: start.endpoint.baseUrl,
    apiKey: start.endpoint.apiKey,
    model: start.endpoint.model,
    protocol: start.endpoint.protocol,
    ...(start.endpoint.headers ? { headers: start.endpoint.headers } : {}),
  };
}

async function runQuestion(start: WorkerStart, question: BankQuestion): Promise<QuestionResult | undefined> {
  const ep = endpointOf(start);
  const samples: SampleResult[] = [];
  const scores: QuestionScore[] = [];

  for (let index = 0; index < start.samples; index++) {
    if (cancelled) return undefined;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const response = await chatOnce(ep, question, {
        signal: controller.signal,
        sampleIndex: index,
        injectFlaky: start.injectFlaky,
      });
      if (cancelled) return undefined;
      const checks = judge(question, response, index);
      const score = scoreQuestion(question, checks, {
        wrapped: detectWrapped(response.text),
        ...(response.error ? { transportError: response.error } : {}),
      });
      samples.push({ index, response, checks, score, repeatRatio: repeatRatio(response.text) });
      scores.push(score);
    } catch (err) {
      if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return undefined;
      // chatOnce 已把网络错误收进 ModelResponse；走到这里说明是编程错误，记一次失败采样。
      const message = err instanceof Error ? err.message : String(err);
      const response = { text: '', error: message };
      const checks = judge(question, response, index);
      const score = scoreQuestion(question, checks, { transportError: message });
      samples.push({ index, response, checks, score, repeatRatio: 0 });
      scores.push(score);
    } finally {
      controllers.delete(controller);
    }
    post({
      type: 'progress',
      done: 0,
      total: 0,
      questionId: question.id,
      sampleIndex: index,
      samples: start.samples,
    });
  }

  if (cancelled || samples.length < start.samples) return undefined;
  // 题均值与状态都只看有效采样：传输失败不是能力结论（D5，实现与聚合共用 core 一份）。
  const stat = sampleStat(scores.filter((s) => s.transportError !== true).map((s) => s.score));
  return {
    questionId: question.id,
    group: question.group,
    prompt: question.prompt,
    judge: question.judge,
    core: question.core === true,
    weight: question.weight ?? 1,
    samples,
    mean: stat.mean,
    halfWidth: stat.halfWidth,
    status: questionStatus(scores),
  };
}

async function run(start: WorkerStart): Promise<void> {
  const results: QuestionResult[] = Object.values(start.done);
  const doneIds = new Set(results.map((r) => r.questionId));
  const pending = start.questions.filter((q) => !doneIds.has(q.id));
  const total = start.questions.length;
  const weights: Record<string, number> = {};
  for (const q of start.questions) weights[q.id] = q.weight ?? 1;

  try {
    for (const question of pending) {
      if (cancelled) break;
      post({ type: 'progress', done: results.length, total, questionId: question.id, sampleIndex: 0, samples: start.samples });
      const result = await runQuestion(start, question);
      if (!result) break;
      results.push(result);
      post({ type: 'question', result });
      post({ type: 'progress', done: results.length, total, questionId: question.id, sampleIndex: start.samples - 1, samples: start.samples });
    }

    const report = aggregate({
      scores: results.flatMap((r) => r.samples.map((s) => s.score)),
      expectedQuestions: total,
      weights,
    });
    post({ type: 'done', report, results, cancelled });
  } catch (err) {
    post({ type: 'fatal', error: err instanceof Error ? err.message : String(err) });
  }
}

scope.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  if (ev.data.type === 'cancel') {
    cancelled = true;
    for (const controller of controllers) controller.abort();
    return;
  }
  if (ev.data.type === 'start') {
    void run(ev.data);
  }
};
