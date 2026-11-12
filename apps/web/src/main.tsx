import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import { AppRoutes } from './routes.js';
import { RunProvider } from './state/RunProvider.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root 不存在');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
      <AntApp>
        <BrowserRouter>
          <RunProvider>
            <AppRoutes />
          </RunProvider>
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
