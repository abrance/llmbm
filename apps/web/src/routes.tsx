import { Layout, Menu, Tag, Typography } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ConnectPage } from './pages/ConnectPage.js';
import { RunPage } from './pages/RunPage.js';
import { ResultPage } from './pages/ResultPage.js';
import { CommunityPage } from './pages/CommunityPage.js';
import { useRun } from './state/runContext.js';

const ITEMS = [
  { key: '/connect', label: '1 · 接入配置' },
  { key: '/run', label: '2 · 跑测' },
  { key: '/result', label: '3 · 结果' },
  { key: '/community', label: '社区榜单' },
];

export function AppRoutes() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { phase } = useRun();
  const selected = ITEMS.find((i) => pathname.startsWith(i.key))?.key ?? '/connect';

  return (
    <Layout className="app-shell">
      <Layout.Sider theme="light" width={212} className="app-sider">
        <div className="brand">
          <span className="brand-mark">L</span>
          <span>
            <strong>llmbm</strong>
            <em>中转站可信度检测</em>
          </span>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[selected]}
          items={ITEMS}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
        <div className="sider-foot">
          {phase === 'running' || phase === 'cancelling' ? (
            <Tag color="processing">{phase === 'running' ? '跑测进行中' : '正在取消'}</Tag>
          ) : (
            <Tag>v0.1 · 本地验收</Tag>
          )}
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
            Key 只在本机浏览器。判分只有 core 一份实现。
          </Typography.Paragraph>
        </div>
      </Layout.Sider>
      <Layout.Content className="app-content">
        <Routes>
          <Route path="/" element={<Navigate to="/connect" replace />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route path="/run" element={<RunPage />} />
          <Route path="/result" element={<ResultPage />} />
          <Route path="/community" element={<CommunityPage />} />
          <Route path="*" element={<Navigate to="/connect" replace />} />
        </Routes>
      </Layout.Content>
    </Layout>
  );
}
