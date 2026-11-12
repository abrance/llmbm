import { Alert, App, Button, Card, Col, Divider, Form, Input, Row, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/Layout.js';
import { fetchModels, isMockBase, pingEndpoint } from '../lib/transport.js';
import { useRun } from '../state/runContext.js';
import type { StoredEndpoint } from '../lib/store.js';

const MOCK: StoredEndpoint = {
  baseUrl: '/__mock/v1',
  apiKey: 'mock-key',
  model: 'mock-llmbm-pro',
  protocol: 'openai',
};

export function ConnectPage() {
  const { message } = App.useApp();
  const { endpoint, saveEndpoint } = useRun();
  const [form] = Form.useForm<StoredEndpoint>();
  const [models, setModels] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [ping, setPing] = useState<string>();
  const baseUrlValue = Form.useWatch('baseUrl', form);
  const navigate = useNavigate();

  useEffect(() => {
    if (endpoint) form.setFieldsValue(endpoint);
  }, [endpoint, form]);

  function current(): StoredEndpoint {
    const values = form.getFieldsValue();
    return {
      baseUrl: (values.baseUrl ?? '').trim(),
      apiKey: (values.apiKey ?? '').trim(),
      model: (values.model ?? '').trim(),
      protocol: values.protocol ?? 'openai',
    };
  }

  async function onFetchModels() {
    const values = current();
    if (!values.baseUrl) {
      message.warning('先填 Base URL');
      return;
    }
    setFetching(true);
    setPing(undefined);
    try {
      const list = await fetchModels({ ...values, model: values.model || 'placeholder' });
      setModels(list);
      if (list.length > 0 && !values.model) form.setFieldValue('model', list[0]);
      message.success(`拉到 ${list.length} 个模型`);
    } catch (err) {
      message.error(`拉取模型失败：${(err as Error).message}`);
    } finally {
      setFetching(false);
    }
  }

  async function onTest() {
    const values = current();
    if (!values.baseUrl || !values.model) {
      message.warning('至少要填 Base URL 和模型 ID');
      return;
    }
    setTesting(true);
    setPing(undefined);
    try {
      const result = await pingEndpoint({ ...values, model: values.model });
      setPing(`连通正常 · ${result.latencyMs}ms · 返回「${result.sample || '（空）'}」`);
      message.success('连通性测试通过');
    } catch (err) {
      setPing(`失败：${(err as Error).message}`);
      message.error('连通性测试失败');
    } finally {
      setTesting(false);
    }
  }

  function onSave(values: StoredEndpoint) {
    saveEndpoint(values);
    message.success('已保存到本机浏览器（服务端不保存 Key）');
    navigate('/run');
  }

  function useMock() {
    saveEndpoint(MOCK);
    form.setFieldsValue(MOCK);
    message.success('已切到内置 Mock：不需要 Key，也不会访问外网');
    navigate('/run');
  }

  const isMock = isMockBase(baseUrlValue ?? endpoint?.baseUrl ?? '');

  return (
    <Space direction="vertical" size={20} style={{ width: '100%' }}>
      <PageHeader
        title="接入配置"
        subtitle="填一个中转站的 Base URL、Key 和模型 ID。Key 只写进本机浏览器，不经过服务端存储；跑测请求默认由浏览器直接发往你填的地址。"
        extra={
          <Button onClick={useMock} type="primary" ghost>
            用内置 Mock 直接体验
          </Button>
        }
      />

      <Row gutter={20}>
        <Col xs={24} lg={15}>
          <Card variant="borderless" className="panel">
            <Form<StoredEndpoint>
              form={form}
              layout="vertical"
              onFinish={onSave}
              initialValues={{ protocol: 'openai' }}
              requiredMark="optional"
            >
              <Form.Item
                name="baseUrl"
                label="Base URL"
                rules={[{ required: true, message: '填中转站地址，如 https://api.example.com/v1' }]}
                extra="填中转站地址：OpenAI 兼容可带或不带 /v1，Anthropic / Gemini 填各自 API 根地址；内置 Mock 填 /__mock/v1。"
              >
                <Input placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} />
              </Form.Item>
              <Form.Item
                name="apiKey"
                label="API Key"
                rules={[{ required: !isMock, message: '填中转站 Key；Mock 模式可留空' }]}
                extra="只保存在本机 localStorage；导出结果、提交社区都不会包含它。"
              >
                <Input.Password placeholder="sk-..." autoComplete="off" />
              </Form.Item>
              <Form.Item name="protocol" label="协议">
                <Select
                  options={[
                    { label: 'OpenAI 兼容', value: 'openai' },
                    { label: 'Anthropic', value: 'anthropic' },
                    { label: 'Gemini', value: 'gemini' },
                  ]}
                />
              </Form.Item>
              <Form.Item name="model" label="模型 ID" rules={[{ required: true, message: '填模型 ID' }]}>
                {models.length > 0 ? (
                  <Select
                    showSearch
                    options={models.map((m) => ({ label: m, value: m }))}
                    placeholder="选择或输入模型 ID"
                    dropdownRender={(menu) => (
                      <>
                        {menu}
                        <Divider style={{ margin: '4px 0' }} />
                        <Input
                          placeholder="也可以直接输入"
                          onPressEnter={(e) => form.setFieldValue('model', (e.target as HTMLInputElement).value)}
                        />
                      </>
                    )}
                  />
                ) : (
                  <Input placeholder="gpt-4o-mini / claude-sonnet-4 / mock-llmbm-pro" autoComplete="off" spellCheck={false} />
                )}
              </Form.Item>
              <Space wrap>
                <Button type="primary" htmlType="submit">
                  保存配置并去跑测
                </Button>
                <Button onClick={() => void onFetchModels()} loading={fetching}>
                  拉取模型列表
                </Button>
                <Button onClick={() => void onTest()} loading={testing}>
                  测试连通性
                </Button>
                <Button
                  onClick={() => {
                    form.resetFields();
                    setModels([]);
                    setPing(undefined);
                  }}
                >
                  清空表单
                </Button>
              </Space>
              {ping ? (
                <Alert
                  style={{ marginTop: 16 }}
                  type={ping.startsWith('失败') ? 'error' : 'success'}
                  showIcon
                  message={ping}
                />
              ) : null}
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card variant="borderless" className="panel">
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                三分钟开始
              </Typography.Title>
              <ol className="steps">
                <li>
                  <strong>配置</strong>：填 Base URL、Key、模型 ID。
                </li>
                <li>
                  <strong>跑测</strong>：选题组、固定 seed，每题采样 3 次。
                </li>
                <li>
                  <strong>看结果</strong>：能力分带区间、维度分、问题探针、证据链。
                </li>
              </ol>
              <Divider />
              <Typography.Text type="secondary">
                当前内置 Mock 模型：<Tag>mock-llmbm-pro</Tag>
                <Tag>mock-llmbm-lite</Tag>
              </Typography.Text>
              <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                Mock 只用于演示流程：答案来自题库的演示字段，不代表任何真实模型的能力。
              </Typography.Paragraph>
            </Card>
            <Alert
              type="info"
              showIcon
              message="隐私边界"
              description={
                <ul className="privacy-list">
                  <li>Key 只进浏览器内存与 localStorage，服务端不落盘、不打日志。</li>
                  <li>跑测请求由浏览器直连你填的 Base URL；只有点「通过代理」时才走同源 /api/proxy。</li>
                  <li>提交社区只上传分数、区间、版本与题号，不上传 Key、Base URL 路径、题目原文和响应原文。</li>
                </ul>
              }
            />
          </Space>
        </Col>
      </Row>
    </Space>
  );
}
