import { Progress } from 'antd';
import { scoreRange } from '../lib/metrics.js';

export function scoreColor(mean: number): string {
  if (mean >= 90) return '#1f9d63';
  if (mean >= 55) return '#d48b16';
  return '#cf3f3f';
}

/** 0~100 的区间条：范围一条，均值一根刻度。 */
export function IntervalBar({ mean, halfWidth }: { mean: number; halfWidth: number }) {
  const { low, high } = scoreRange(mean, halfWidth);
  return (
    <div className="interval-bar" aria-label={`${mean.toFixed(1)} 加减 ${halfWidth.toFixed(1)}`}>
      <div className="interval-rail" />
      <div className="interval-range" style={{ left: `${low}%`, width: `${Math.max(high - low, 0.8)}%` }} />
      <div className="interval-mean" style={{ left: `${Math.max(0, Math.min(100, mean))}%` }} />
      <span className="interval-label">{halfWidth > 0 ? `${low.toFixed(0)}–${high.toFixed(0)}` : '区间 0'}</span>
    </div>
  );
}

export function ScoreDial({ mean, halfWidth, n }: { mean: number; halfWidth: number; n: number }) {
  return (
    <div className="score-dial">
      <Progress
        type="dashboard"
        percent={Math.round(mean)}
        size={190}
        strokeWidth={9}
        strokeColor={scoreColor(mean)}
        trailColor="#eef0f3"
        format={() => (
          <span className="score-dial-value">
            <strong>{mean.toFixed(1)}</strong>
            <em>± {halfWidth.toFixed(1)}</em>
            <small>n={n}</small>
          </span>
        )}
      />
      <p className="score-dial-note">能力分 95% 置信区间（每题 {Math.max(1, Math.round(n))} 次采样）</p>
    </div>
  );
}
