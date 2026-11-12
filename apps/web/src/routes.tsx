import { Layout, Menu, Typography } from 'antd';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ConnectPage } from './pages/ConnectPage.js';
import { RunPage } from './pages/RunPage.js';
import { ResultPage } from './pages/ResultPage.js';
import { CommunityPage } from './pages/CommunityPage.js';

const ITEMS = [
  { key: '/connect', label: '接入配置' },
  { key: '/run', label: '跑测' },
  { key: '/result', label: '结果' },
  { key: '/community', label: '社区' },
];

export function AppRoutes() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const selected = ITEMS.find((i) => pathname.startsWith(i.key))?.key ?? '/connect';

  return (
    <Layout className="app-shell">
      <Layout.Header style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <Typography.Text strong style={{ color: '#fff', fontSize: 16, whiteSpace: 'nowrap' }}>
          llmbm
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[selected]}
          items={ITEMS}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1, minWidth: 0 }}
        />
      </Layout.Header>
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
