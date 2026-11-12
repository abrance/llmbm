/**
 * D5 代理安全护栏：目标地址校验（拒私网/回环/云元数据）+ 并发上限 + 单请求超时。
 * 这里只做判定与计数，真正的转发在 routes/proxy.ts。
 */

const METADATA_HOSTS = new Set(['169.254.169.254', 'metadata.google.internal', 'metadata', '100.100.100.200']);

function ipv4InPrivateRange(host: string): boolean {
  const parts = host.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = 0, b = 0] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export interface TargetCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 校验代理目标。只允许 http/https；拒绝非默认端口以外的私网目标。
 * 注意：这里不做 DNS 解析后再校验（TOCTOU 无解），因此对域名只挡明显危险名，
 * 真正的私网防护靠部署侧出口策略。
 */
export function checkTarget(rawUrl: string): TargetCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: '目标地址不是合法 URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `不支持的协议 ${url.protocol}` };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: '目标地址缺少主机名' };
  if (METADATA_HOSTS.has(host)) return { ok: false, reason: '拒绝云元数据地址' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return { ok: false, reason: '拒绝本地/内网主机名' };
  }
  if (ipv4InPrivateRange(host)) return { ok: false, reason: '拒绝私网/回环地址' };
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return { ok: false, reason: '拒绝 IPv6 私网/回环地址' };
  }
  return { ok: true };
}

/** 并发闸门：超过上限直接拒绝，不排队（排队会把上游超时堆成雪崩）。 */
export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly limit: number) {}

  tryEnter(): boolean {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }

  leave(): void {
    this.active = Math.max(0, this.active - 1);
  }

  get inFlight(): number {
    return this.active;
  }
}

/** 简单退避：429/5xx 时重试，其余不重试。 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export const DEFAULTS = {
  /** 单请求超时（毫秒）。 */
  timeoutMs: 120_000,
  /** 同时进行的代理请求上限。 */
  maxConcurrency: 8,
  /** 请求体上限（字节）。 */
  bodyLimit: 1024 * 1024,
} as const;
