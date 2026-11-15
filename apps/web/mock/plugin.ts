/**
 * 内置 Mock 端点（仅 dev / preview）：`/__mock/v1`。
 * 用途：不填 Key、不连外网也能跑完整流程；答案来自题库的 mock 字段，纯演示数据。
 * 生产构建不包含这个中间件 —— 它不是任何真实模型的替代品。
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

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

/** 超时组的首字延迟（ms）：让 E2E 能看到 TTFT，不是真实模型的性能。 */
const TIMEOUT_FIRST_CHUNK: Record<string, number> = {
  'timeout-ttft-001': 1200,
  'timeout-heartbeat-001': 400,
  'timeout-short-001': 150,
};

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
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
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

/**
 * 超时组的演示流：首字延迟按题配置，正文切成 3 片。只用于本地演示与 E2E，
 * 不模拟真实超时（挂起题在 Mock 里也会正常返回，避免本地验收白等 45 秒）。
 */
function sendTimeoutStream(
  res: ServerResponse,
  questionId: string,
  text: string,
  sample: number,
): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('connection', 'keep-alive');
  const first = (TIMEOUT_FIRST_CHUNK[questionId] ?? 60) + sample * 10;
  const chunks = text.match(/[\s\S]{1,40}/g) ?? [text];
  const frame = (delta: string, finish?: string) => {
    const payload = { choices: [{ delta: { content: delta }, ...(finish ? { finish_reason: finish } : {}) }] };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  const timers: NodeJS.Timeout[] = [];
  timers.push(
    setTimeout(() => {
      frame('');
      chunks.forEach((chunk, index) => {
        timers.push(
          setTimeout(() => {
            frame(chunk);
            if (index === chunks.length - 1) {
              res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: usageOf('', text) })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }
          }, 30 * (index + 1)),
        );
      });
    }, first),
  );
  res.on('close', () => {
    for (const timer of timers) clearTimeout(timer);
  });
}

function handler(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void {
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
        const prompt = (body.messages ?? [])
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .join('\n');
        const answer = mockAnswer(questionId, sample, flaky);
        const text = answer.text;
        const delay = 25 + ((questionId.length * 13 + Number(sample) * 7) % 55);
        // 故障注入时让「彻底挂起」题真的不返回：用来在本地演示/验收超时结论（默认关闭，避免每次验收白等）。
        if (flaky && questionId === 'timeout-hang-001') {
          res.statusCode = 200;
          res.setHeader('content-type', 'text/event-stream; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.write(': keepalive\n\n');
          return;
        }
        // 超时组用 SSE 分片返回：只有流式响应才有 TTFT 与分片数，E2E 才能验证时延结论。
        if (groups.get(questionId) === 'timeout') {
          sendTimeoutStream(res, questionId, text, Number(sample));
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
}

/** Vite 插件：dev 与 preview 都挂同一个中间件。 */
export function mockApiPlugin(): Plugin {
  return {
    name: 'llmbm-mock-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
