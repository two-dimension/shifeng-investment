import React, { useEffect, useState } from 'react';
import { Modal, Form, Input, InputNumber, Select } from 'antd';
import { type Fund } from '../../types/fund';

const INITIAL_MAP = {
  a: { value: 1000000, label: '元', suffix: '初始规模默认为 100万元' },
  hk: { value: 1000000, label: '港币', suffix: '初始规模默认为 100万港币' },
  us: { value: 100000, label: '美元', suffix: '初始规模默认为 10万美元' },
  jp: { value: 10000000, label: '日元', suffix: '初始规模默认为 1000万日元' },
  kr: { value: 10000000, label: '韩元', suffix: '初始规模默认为 1000万韩元' },
};

interface AddFundModalProps {
  open: boolean;
  fund?: Fund;
  onClose: () => void;
  onSave: (name: string, initialCapital: number, market?: 'a' | 'hk' | 'us' | 'jp' | 'kr') => void;
}

const AddFundModal: React.FC<AddFundModalProps> = ({ open, fund, onClose, onSave }) => {
  const [form] = Form.useForm();
  const isEdit = !!fund;
  const [market, setMarket] = useState<'a' | 'hk' | 'us' | 'jp' | 'kr'>('a');

  useEffect(() => {
    if (open) {
      if (fund) {
        form.setFieldsValue({ name: fund.name, initialCapital: Math.round(fund.initialCapital) });
      } else {
        setMarket('a');
        form.setFieldsValue({ initialCapital: 1000000, market: 'a' });
      }
    }
  }, [open, fund, form]);

  const handleOk = () => {
    form.validateFields().then((values) => {
      if (isEdit) {
        onSave(values.name, Number(values.initialCapital));
      } else {
        const m: 'a' | 'hk' | 'us' | 'jp' | 'kr' = values.market || 'a';
        onSave(values.name, Number(values.initialCapital) || INITIAL_MAP[m].value, m);
      }
      onClose();
    });
  };

  const handleMarketChange = (v: 'a' | 'hk' | 'us' | 'jp' | 'kr') => {
    setMarket(v);
    form.setFieldsValue({ initialCapital: INITIAL_MAP[v].value });
  };

  return (
    <Modal
      title={isEdit ? '编辑基金' : '添加基金'}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText={isEdit ? '保存' : '添加'}
      cancelText="取消"
      destroyOnHidden
    >
      <div onKeyDown={(e) => { if (e.key === 'Enter') handleOk(); }}>
        <Form form={form} layout="vertical">
          <Form.Item name="name" label="基金名称" rules={[{ required: true, message: '请输入基金名称' }]}>
            <Input placeholder="如 锋行成长1号" />
          </Form.Item>
          {!isEdit && (
            <>
              <Form.Item name="market" label="市场" rules={[{ required: true, message: '请选择市场' }]}>
                <Select onChange={handleMarketChange}>
                  <Select.Option value="a">A股</Select.Option>
                  <Select.Option value="hk">港股</Select.Option>
                  <Select.Option value="us">美股</Select.Option>
                  <Select.Option value="jp">日股</Select.Option>
                  <Select.Option value="kr">韩股</Select.Option>
                </Select>
              </Form.Item>
              <Form.Item
                label={`初始规模（${INITIAL_MAP[market].label}）`}
                extra={INITIAL_MAP[market].suffix}
              >
                <Form.Item name="initialCapital" noStyle>
                  <InputNumber style={{ width: '100%' }} min={0} />
                </Form.Item>
              </Form.Item>
            </>
          )}
        </Form>
      </div>
    </Modal>
  );
};

export default AddFundModal;
