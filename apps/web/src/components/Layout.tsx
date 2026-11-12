import { Tag, Typography } from 'antd';
import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, extra }: { title: string; subtitle?: string; extra?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {subtitle ? (
          <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', maxWidth: 760 }}>
            {subtitle}
          </Typography.Paragraph>
        ) : null}
      </div>
      {extra ? <div className="page-head-extra">{extra}</div> : null}
    </div>
  );
}

export function SectionCard({
  title,
  hint,
  extra,
  children,
}: {
  title: string;
  hint?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="section-card">
      <header className="section-head">
        <div>
          <h3>{title}</h3>
          {hint ? <p>{hint}</p> : null}
        </div>
        {extra}
      </header>
      {children}
    </section>
  );
}

export function ScoreTag({ status }: { status: string }) {
  if (status === 'pass') return <Tag color="success">pass</Tag>;
  if (status === 'pending_review') return <Tag color="warning">待复核</Tag>;
  return <Tag color="error">fail</Tag>;
}
