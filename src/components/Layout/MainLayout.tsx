import React, { useState } from 'react';
import { Layout, Menu, Avatar, Dropdown, Switch, Typography, Space, Button, Grid } from 'antd';
import {
  LineChartOutlined,
  PieChartOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  SunOutlined,
  MoonOutlined,
  UserOutlined,
  SettingOutlined,
  LogoutOutlined,
  FileProtectOutlined,
  RiseOutlined,
  HomeOutlined,
  FundProjectionScreenOutlined,
  CalendarOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation, Outlet } from 'react-router-dom';
import { useTheme } from '../../hooks/useTheme';

const { Header, Sider, Content } = Layout;
const { Text } = Typography;
const { useBreakpoint } = Grid;
const LOGO_SRC = '/shifeng-logo.jpg';

const MainLayout: React.FC = () => {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();
  const screens = useBreakpoint();
  const isMobile = !screens.md;
  const effectiveCollapsed = isMobile || collapsed;

  const menuItems = [
    {
      key: '/home',
      icon: <HomeOutlined />,
      label: '首页',
    },
    {
      key: '/news',
      icon: <FileProtectOutlined />,
      label: '新闻资讯',
    },
    {
      key: '/calendar',
      icon: <CalendarOutlined />,
      label: '日历',
    },
    {
      key: '/ai-dashboard',
      icon: <RobotOutlined />,
      label: 'AI看板',
    },
    {
      key: '/portfolio',
      icon: <PieChartOutlined />,
      label: '子集',
    },
    {
      key: '/macd',
      icon: <LineChartOutlined />,
      label: 'MACD选股',
    },
    {
      key: '/tmt-margin',
      icon: <RiseOutlined />,
      label: '拥挤度追踪',
    },
    {
      key: '/research',
      icon: <FundProjectionScreenOutlined />,
      label: '公告监控',
    },
  ];

  const userMenuItems = [
    {
      key: 'profile',
      icon: <UserOutlined />,
      label: '个人中心',
    },
    {
      key: 'settings',
      icon: <SettingOutlined />,
      label: '设置',
    },
    {
      type: 'divider' as const,
    },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出登录',
    },
  ];

  const handleMenuClick = (key: string) => {
    navigate(key);
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        trigger={null}
        collapsible
        collapsed={effectiveCollapsed}
        width={220}
        collapsedWidth={isMobile ? 64 : 80}
        style={{
          background: theme === 'dark' ? '#1f1f1f' : '#ffffff',
          borderRight: theme === 'dark' ? '1px solid #303030' : '1px solid #f0f0f0',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: effectiveCollapsed ? 'center' : 'flex-start',
            padding: effectiveCollapsed ? 0 : '0 20px',
            borderBottom: theme === 'dark' ? '1px solid #303030' : '1px solid #f0f0f0',
          }}
        >
          {effectiveCollapsed ? (
            <Button type="text" onClick={() => navigate('/home')} style={{ height: 'auto', padding: 0 }}>
              <img
                src={LOGO_SRC}
                alt="石锋资产"
                style={{
                  width: 38,
                  height: 38,
                  display: 'block',
                  objectFit: 'contain',
                  borderRadius: 8,
                  background: '#fff',
                  padding: 3,
                  border: theme === 'dark' ? '1px solid #303030' : '1px solid #f0f0f0',
                }}
              />
            </Button>
          ) : (
            <Button type="text" onClick={() => navigate('/home')} style={{ height: 'auto', padding: 0 }}>
              <Space size={10}>
                <img
                  src={LOGO_SRC}
                  alt="石锋资产"
                  style={{
                    width: 34,
                    height: 34,
                    display: 'block',
                    objectFit: 'contain',
                    borderRadius: 8,
                    background: '#fff',
                    padding: 3,
                    border: theme === 'dark' ? '1px solid #303030' : '1px solid #f0f0f0',
                  }}
                />
                <Text strong style={{ fontSize: 20, color: '#ff4d4f' }}>石锋资产</Text>
              </Space>
            </Button>
          )}
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => handleMenuClick(key)}
          style={{
            borderRight: 0,
            marginTop: 8,
          }}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            padding: isMobile ? '0 12px' : '0 24px',
            background: theme === 'dark' ? '#1f1f1f' : '#ffffff',
            borderBottom: theme === 'dark' ? '1px solid #303030' : '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Button
            type="text"
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            style={{ visibility: isMobile ? 'hidden' : 'visible' }}
          />
          <Space size={isMobile ? 10 : 16}>
            <Space size={8}>
              <SunOutlined style={{ color: theme === 'light' ? '#faad14' : '#666' }} />
              <Switch
                size="small"
                checked={theme === 'dark'}
                onChange={() => toggleTheme()}
              />
              <MoonOutlined style={{ color: theme === 'dark' ? '#177ddc' : '#666' }} />
            </Space>
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Avatar icon={<UserOutlined />} style={{ cursor: 'pointer' }} />
            </Dropdown>
          </Space>
        </Header>
        <Content
          style={{
            margin: isMobile ? 12 : 24,
            padding: isMobile ? 12 : 24,
            background: theme === 'dark' ? '#141414' : '#f5f7fa',
            borderRadius: 8,
            minHeight: 280,
            overflow: 'auto',
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
};

export default MainLayout;
