/**
 * 内置 Mock 端点的请求处理（仅 dev / preview 与单测）：`/__mock/v1`。
 *
 * 用途：不填 Key、不连外网也能跑完整流程；答案来自题库的 mock 字段，纯演示数据。
 * 故障注入走请求头（`x-llmbm-inject: flaky` 或显式 `x-llmbm-fault: <mode>`），
 * 同一题同一样本每次得到同一行为 —— E2E 与人工复核都能复现。
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type MockFault = 'slow-first' | 'hang' | 'stall' | 'drip' | 'long-output';

export const MOCK_FAULTS: readonly MockFault[] = ['slow-first', 'hang', 'stall', 'drip', 'long-output'];

interface MockQuestion {
  id: string;
  group?: string;
  mock?: { text?: string; toolCalls?: { name: string; arguments: string }[]; finishReason?: string };
}

interface BankFile {
  questions: MockQuestion[];
}

const BANK_PATH = new URL('../../../packages/core/src/data/questions.json', import.meta.url);
const bank = JSON.parse(readFileSync(BANK_PATH, 'utf8')) as BankFile;
const answers = new Map(bank.questions.map((q) => [q.id, q.mock]));
const groups = new Map(bank.questions.map((q) => [q.id, q.group]));

/** `x-llmbm-inject: flaky`（跑测页开关）时每题默认演示哪种坏法；没列的题按正常返回。 */
const FAULT_BY_QUESTION: Record<string, MockFault> = {
  'timeout-ttft-001': 'slow-first',
  'timeout-heartbeat-001': 'slow-first',
  'timeout-hang-001': 'hang',
  'timeout-stream-stall-001': 'stall',
  'timeout-drip-001': 'drip',
  'timeout-long-001': 'long-output',
  'timeout-budget-001': 'long-output',
};

/** 首字延迟（ms）：让 E2E 能看到 TTFT，不是真实模型的性能。 */
const TIMEOUT_FIRST_CHUNK: Record<string, number> = {
  'timeout-ttft-001': 1200,
  'timeout-heartbeat-001': 400,
  'timeout-short-001': 150,
};

/** 只注入到第一次采样：同一样本永远同样的行为，其余采样保持正常，方便看区间与归因。 */
const FAULT_SAMPLE = '0';

export function mockFaultOf(questionId: string, header: string | undefined, sample: string): MockFault | '' {
  if (!header || sample !== FAULT_SAMPLE) return '';
  if (header === 'auto' || header === 'flaky') return FAULT_BY_QUESTION[questionId] ?? '';
  return MOCK_FAULTS.includes(header as MockFault) ? (header as MockFault) : '';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function usageOf(prompt: string, text: string): Record<string, number> {
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const completionTokens = Math.max(1, Math.ceil(text.length / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function mockAnswer(
  questionId: string,
  sample: string,
  flaky: boolean,
): { text: string; toolCalls?: { name: string; arguments: string }[]; finishReason?: string } {
  const answer = answers.get(questionId);
  if (!answer) {
    return { text: '这是 llmbm 内置 Mock 的占位回答（该题没有演示答案）。' };
  }
  // 故障注入：只影响一道题的一次采样，用来演示区间、探针与单题重试。
  if (flaky && questionId === 'basic-exact-002' && sample === '1') {
    return { text: 'Cat' };
  }
  return {
    text: answer.text ?? '',
    ...(answer.toolCalls ? { toolCalls: answer.toolCalls } : {}),
    ...(answer.finishReason ? { finishReason: answer.finishReason } : {}),
  };
}

function sseHeaders(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('connection', 'keep-alive');
}

function frame(res: ServerResponse, delta: string, finish?: string): void {
  const payload = { choices: [{ delta: { content: delta }, ...(finish ? { finish_reason: finish } : {}) }] };
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 超时组的演示流：按题目与故障模式决定首字延迟与分片节奏。
 * 只用于本地演示与 E2E；默认（无故障头）不会模拟真实超时，避免本地验收白等几十秒。
 */
function sendTimeoutStream(
  res: ServerResponse,
  questionId: string,
  text: string,
  sample: number,
  fault: MockFault | '',
): void {
  sseHeaders(res);
  const timers: NodeJS.Timeout[] = [];
  const close = () => {
    for (const timer of timers) clearTimeout(timer);
  };
  res.on('close', close);

  if (fault === 'hang') {
    // 连接一直开着、一个字节都不发：只能靠客户端 timeout 收口。
    return;
  }

  const first = fault === 'slow-first' ? 3200 : (TIMEOUT_FIRST_CHUNK[questionId] ?? 60) + sample * 10;
  const size = fault === 'drip' ? 8 : fault === 'long-output' ? 24 : 40;
  const gap = fault === 'drip' ? 700 : fault === 'long-output' ? 120 : 30;
  const chunks = text.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? [text];
  const limit = fault === 'stall' ? Math.min(2, chunks.length) : chunks.length;

  timers.push(
    setTimeout(() => {
      frame(res, '');
      for (let index = 0; index < limit; index += 1) {
        timers.push(
          setTimeout(
            () => {
              frame(res, chunks[index] as string);
              if (index === limit - 1 && fault !== 'stall') {
                res.write(
                  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: usageOf('', text) })}\n\n`,
                );
                res.write('data: [DONE]\n\n');
                res.end();
              }
              // stall：到点就停手，不发 finish_reason、不关连接 —— HTTP 200 的「半截回答」。
            },
            gap * (index + 1),
          ),
        );
      }
    }, first),
  );
}

/** 生成 Mock 请求处理器；Vite 插件与单测都挂同一份实现。 */
export function createMockHandler(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void {
  return function handler(req, res, next) {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (!url.startsWith('/__mock/')) {
      next();
      return;
    }

    if (req.method === 'GET' && url === '/__mock/v1/models') {
      sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'mock-llmbm-pro', object: 'model', owned_by: 'llmbm' },
          { id: 'mock-llmbm-lite', object: 'model', owned_by: 'llmbm' },
        ],
      });
      return;
    }

    if (req.method === 'POST' && url === '/__mock/v1/chat/completions') {
      void readBody(req)
        .then((raw) => {
          let body: { messages?: { content?: unknown }[]; model?: string } = {};
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            sendJson(res, 400, { error: { message: '请求体不是合法 JSON' } });
            return;
          }
          const questionId = String(req.headers['x-llmbm-question-id'] ?? '');
          const sample = String(req.headers['x-llmbm-sample'] ?? '0');
          const flaky = String(req.headers['x-llmbm-inject'] ?? '') === 'flaky';
          const fault = mockFaultOf(
            questionId,
            String(req.headers['x-llmbm-fault'] ?? '') || (flaky ? 'flaky' : ''),
            sample,
          );
          const prompt = (body.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
          const answer = mockAnswer(questionId, sample, flaky);
          const text = answer.text;
          const delay = 25 + ((questionId.length * 13 + Number(sample) * 7) % 55);

          // 超时组一律用 SSE 分片：只有流式响应才有 TTFT 与分片数，E2E 才能验证时延结论。
          if (groups.get(questionId) === 'timeout') {
            sendTimeoutStream(res, questionId, text, Number(sample), fault);
            return;
          }

          setTimeout(() => {
            const message: Record<string, unknown> = { role: 'assistant', content: answer.toolCalls ? null : text };
            if (answer.toolCalls) {
              message['tool_calls'] = answer.toolCalls.map((call, index) => ({
                id: `call_mock_${index}`,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              }));
            }
            sendJson(res, 200, {
              id: `chatcmpl-mock-${questionId || 'unknown'}-${sample}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: body.model ?? 'mock-llmbm-pro',
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason: answer.finishReason ?? (answer.toolCalls ? 'tool_calls' : 'stop'),
                },
              ],
              usage: usageOf(prompt, text),
            });
          }, delay);
        })
        .catch(() => sendJson(res, 400, { error: { message: '读取请求体失败' } }));
      return;
    }

    sendJson(res, 404, { error: { message: `mock 端点不支持 ${req.method ?? 'GET'} ${url}` } });
  };
}
