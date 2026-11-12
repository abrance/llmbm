import { Alert, Button, Card, Form, Input, Select, Space, Typography, message } from 'antd';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clearEndpoint, loadEndpoint, saveEndpoint, type StoredEndpoint } from '../lib/store.js';

export function ConnectPage() {
  const [form] = Form.useForm<StoredEndpoint>();
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    const saved = loadEndpoint();
    if (saved) form.setFieldsValue(saved);
  }, [form]);

  async function fetchModels(values: StoredEndpoint) {
    setLoading(true);
    try {
      const res = await fetch(`/api/models?baseUrl=${encodeURIComponent(values.baseUrl)}`, {
        headers: { authorization: `Bearer ${values.apiKey}` },
      });
      if (!res.ok) {
        const text = await res.text();
        message.error(`拉取模型失败（${res.status}）：${text.slice(0, 200)}`);
        return;
      }
      const json = (await res.json()) as { data?: { id?: string }[] };
      const ids = (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
      setModels(ids);
      message.success(`拉到 ${ids.length} 个模型`);
    } catch (err) {
      message.error(`请求失败：${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  function onSave(values: StoredEndpoint) {
    const ok = saveEndpoint(values);
    if (!ok) {
      message.warning('浏览器存储不可用（可能是隐私模式），本次配置仅在内存中有效');
      return;
    }
    message.success('已保存到本机浏览器（服务端不保存 Key）');
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Typography.Title level={4} style={{ margin: 0 }}>
        接入配置
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        message="Key 只存在本机浏览器"
        description="API Key 仅保存在本机浏览器存储中，服务端代理不落 Key、不落请求体。只有在你显式允许走代理时，请求才会经过本服务。"
      />
      <Card>
        <Form<StoredEndpoint> form={form} layout="vertical" onFinish={onSave} initialValues={{ protocol: 'openai' }}>
          <Form.Item
            name="baseUrl"
            label="Base URL"
            rules={[{ required: true, message: '填中转站 Base URL，如 https://api.example.com/v1' }]}
          >
            <Input placeholder="https://api.example.com/v1" autoComplete="off" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key" rules={[{ required: true, message: '填 Key' }]}>
            <Input.Password placeholder="sk-..." autoComplete="off" />
          </Form.Item>
          <Form.Item name="model" label="模型 ID" rules={[{ required: true, message: '填模型 ID' }]}>
            {models.length > 0 ? (
              <Select
                showSearch
                options={models.map((m) => ({ label: m, value: m }))}
                placeholder="选择或直接输入"
              />
            ) : (
              <Input placeholder="gpt-4o-mini" autoComplete="off" />
            )}
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
          <Space>
            <Button onClick={() => void form.validateFields().then(fetchModels)} loading={loading}>
              拉取模型列表
            </Button>
            <Button type="primary" htmlType="submit">
              保存配置
            </Button>
            <Button
              onClick={() => {
                clearEndpoint();
                form.resetFields();
                message.success('已清除本机保存的配置');
              }}
            >
              清除
            </Button>
            <Button type="link" onClick={() => navigate('/run')}>
              下一步：跑测
            </Button>
          </Space>
        </Form>
      </Card>
    </Space>
  );
}
