/**
 * /api/community/*：结果提交与榜单查询（F12）。
 * 只存判分结果与元信息，不存 Key、不存原始请求体（D4）。
 */
import type { FastifyInstance } from 'fastify';
import type { Repo } from '../repo/results.js';

interface SubmitBody {
  /** 参与社区榜单必须显式勾选（前端默认不勾选），缺失即拒，避免任何客户端悄悄公开分数。 */
  consent?: boolean;
  domain?: string;
  model?: string;
  protocol?: string;
  capabilityScore?: number;
  capabilityHalfWidth?: number;
  formatScore?: number;
  stability?: number;
  questionBankVersion?: string;
  judgeRuleVersion?: string;
  payload?: unknown;
}

interface ListQuery {
  domain?: string;
  model?: string;
  limit?: string;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function registerCommunityRoutes(app: FastifyInstance, repo: Repo): void {
  app.post<{ Body: SubmitBody }>('/api/community/submit', async (request, reply) => {
    const b = request.body ?? {};
    if (b.consent !== true) {
      return reply.code(400).send({ error: '需要显式勾选参与社区榜单（consent=true）' });
    }
    const missing = (['domain', 'model', 'protocol', 'questionBankVersion', 'judgeRuleVersion'] as const).filter(
      (k) => typeof b[k] !== 'string' || !(b[k] as string).trim(),
    );
    if (missing.length) return reply.code(400).send({ error: `缺少字段：${missing.join(', ')}` });
    if (!isNum(b.capabilityScore) || !isNum(b.capabilityHalfWidth) || !isNum(b.formatScore) || !isNum(b.stability)) {
      return reply.code(400).send({ error: '分数字段必须是有限数字' });
    }
    if (b.capabilityScore < 0 || b.capabilityScore > 100) {
      return reply.code(400).send({ error: 'capabilityScore 必须在 0~100' });
    }

    const row = await repo.insert({
      domain: b.domain as string,
      model: b.model as string,
      protocol: b.protocol as string,
      capabilityScore: b.capabilityScore,
      capabilityHalfWidth: b.capabilityHalfWidth,
      formatScore: b.formatScore,
      stability: b.stability,
      questionBankVersion: b.questionBankVersion as string,
      judgeRuleVersion: b.judgeRuleVersion as string,
      payload: b.payload ?? null,
    });
    return reply.code(201).send({ id: row.id, createdAt: row.createdAt });
  });

  app.get<{ Querystring: ListQuery }>('/api/community/results', async (request, reply) => {
    const { domain, model, limit } = request.query;
    const parsedLimit = limit ? Number(limit) : undefined;
    const rows = await repo.list({
      ...(domain ? { domain } : {}),
      ...(model ? { model } : {}),
      ...(parsedLimit !== undefined && Number.isFinite(parsedLimit) ? { limit: parsedLimit } : {}),
    });
    return reply.send({
      total: rows.length,
      items: rows.map((r) => ({ ...r, payload: undefined })),
    });
  });

  app.get<{ Params: { id: string } }>('/api/community/results/:id', async (request, reply) => {
    const row = await repo.get(request.params.id);
    if (!row) return reply.code(404).send({ error: '结果不存在' });
    return reply.send(row);
  });
}
