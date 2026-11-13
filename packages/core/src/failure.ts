/**
 * 端点错误的性质判定（docs/SPEC.md F14）：决定「要不要停整卷」。
 *
 * 关键区分不是我方猜的，而是「换题/重试能不能变好」：
 * - account：账户/额度/订阅层面（401/402/403，或响应体明说欠费、余额、订阅过期、
 *   配额耗尽）。换题和重试都不会恢复，只有人去充值或换 Key，所以第一次命中就停整卷。
 * - config：路径/模型名不存在（404）。同样是换题没用，第一次命中就停。
 * - request：端点拒绝这个请求的形状（400/422/413/415…，例如 thinking 模式要求多轮
 *   里回传 reasoning_content、参数不被接受）。这是「这一题的请求不被接受」，不能推断
 *   整个端点不可用 —— 记为该次采样失败、压低稳定性，不终止整卷。
 * - transient：429/5xx/超时/网络错误。偶发可容忍，连续命中才判端点不可用。
 */
export type FailureKind = 'account' | 'config' | 'request' | 'transient' | 'unknown';

/** 账户/额度类信号：状态码之外，还要看网关把欠费塞在什么状态里。 */
const ACCOUNT_PATTERN =
  /insufficient_quota|exceeded your current quota|quota exceeded|billing|payment required|arrears|credit balance|out of credits|add a payment method|please recharge|subscription\s+(?:has\s+)?(?:expired|cancell?ed|inactive)|plan\s+(?:has\s+)?expired|account\s+(?:is\s+)?(?:suspended|expired)|api[ _-]?key\s+(?:is\s+)?(?:invalid|revoked|expired)|欠费|余额不足|额度(?:不足|已用尽|耗尽)|账户(?:已)?(?:过期|到期|停用|冻结|禁用|被禁|失效)|(?:订阅|套餐|会员)(?:已)?(?:过期|到期|失效|用尽|耗尽)|未开通|请充值/i;

/** 「请求形状不被接受」类状态：答案里没有能力结论，但也不是端点挂了。 */
const REQUEST_STATUSES = new Set([400, 405, 406, 409, 410, 413, 414, 415, 422, 451, 501]);

export interface FailureInput {
  httpStatus?: number;
  error?: string;
}

export function classifyFailure(input: FailureInput): FailureKind {
  const status = input.httpStatus;
  const message = input.error ?? '';
  // 没有状态码 = 连响应都没拿到（超时/网络错误），只能当瞬时问题重试。
  if (status === undefined) return 'transient';
  if (status === 401 || status === 402 || status === 403) return 'account';
  if (status === 404) return 'config';
  if (ACCOUNT_PATTERN.test(message)) return 'account';
  if (status === 429) return 'transient';
  if (status >= 500 && status <= 599) return 'transient';
  if (REQUEST_STATUSES.has(status)) return 'request';
  return 'unknown';
}

export function failureAdvice(kind: FailureKind): string {
  switch (kind) {
    case 'account':
      return '账户层面不可用（额度/订阅/Key），换题重试都不会恢复。请先处理计费与 Key，再重跑。';
    case 'config':
      return '端点配置有问题（baseUrl 或模型名），换题重试都不会恢复。请检查配置后重跑。';
    case 'request':
      return '端点拒绝了请求形状，属该题结论，不终止整卷。';
    case 'transient':
      return '瞬时故障，可重试容忍，连续命中才判端点不可用。';
    default:
      return '未归类的端点错误。';
  }
}
