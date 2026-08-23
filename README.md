# 石锋资产投研平台

## AI 投资看板配置

AI 看板位于 `/ai-dashboard`，沿用网站现有访问边界，不再要求单独输入访问口令。实时数据源可配置：

```bash
export FEISHU_APP_ID='cli_xxx'
export FEISHU_APP_SECRET='xxx'
export FEISHU_AI_SHEET_TOKEN='F9W3s5BBEhRRV8tdZvCchEAfnCf'
export OPENROUTER_API_KEY='sk-or-v1-xxx'
```

本地开发也可以将同名变量写入仓库根目录的 `.env.local`；`npm run server` 会自动加载该文件，且该文件已被 Git 忽略。系统环境变量优先于 `.env.local` 中的同名配置。没有飞书 API 凭证时，服务会读取 `server/data/ai-dashboard/feishu-export.json` 作为本地只读快照。

飞书应用只需电子表格读取权限，并需要作为协作者加入源表。服务端会按工作表名称发现 sheet ID。飞书每小时同步；OpenRouter 公开流量榜和 Benchmark 每日独立同步，也可以在页面手动刷新。

`OPENROUTER_API_KEY` 同时用于公开 Token 排名 Data API、文本模型目录和统一 Benchmark API。这些都是数据读取请求，不会调用模型推理，也不会产生 Token 推理费用；但需要有效的 OpenRouter key，并受 OpenRouter 接口限流与政策约束。Benchmark 默认只展示每个已跟踪厂商最新发布的文本模型，综合 OpenRouter 汇总的 Artificial Analysis、Design Arena 和 OpenRouter Evals；旧模型已有得分不会顶替最新但尚未评测的模型。进入 Benchmark 页签时会检查数据，15 分钟内已同步的快照会直接复用。

未配置 OpenRouter key 时，页面可读取本地保存的官方公开榜单 Top 10，但不会把 Top 10 合计冒充全平台总量；Benchmark 继续显示飞书或最后一版在线快照，并明确标记过期/待授权。快照原子写入 `server/data/ai-dashboard/snapshot.json`，单一来源失败时继续返回上一版数据并标记过期。

## 本地公网访问

推荐使用两种方式（二选一）：

### 1) 免费稳定版（Cloudflare Named Tunnel，推荐）

这是更稳一点的方式：你给它一个固定的 Cloudflare 子域名，重启后链接不会变。

前提：

- 你在 Cloudflare 上有一个域名（有免费账户即可配置 Tunnel）。
- 已安装 `cloudflared`。

部署步骤：

```bash
brew install cloudflared
```

1. 在 Cloudflare 创建一个 Tunnel，并拿到 `Tunnel token`。
2. 在 Cloudflare 的 `DNS` 中加一条你想用的子域名（比如 `inv.shifeng.com`）指向这个 Tunnel。
3. 在本机创建一个环境文件（不放进仓库）：

```bash
cat > ~/.config/shifeng-investment/tunnel.env <<'EOF'
export CLOUDFLARE_TUNNEL_TOKEN=你的_TOKEN
export CLOUDFLARE_TUNNEL_MODE=stable
export CLOUDFLARE_TUNNEL_TRANSPORT_PROTOCOL=http2
export CLOUDFLARE_TUNNEL_HOSTNAME=inv.shifeng.com
export CLOUDFLARE_TUNNEL_EDGE_IP_VERSION=auto
export CLOUDFLARE_TUNNEL_NAME=shifeng-investment
EOF
chmod 600 ~/.config/shifeng-investment/tunnel.env
```

4. 在项目目录运行：

```bash
npm run public:tunnel
```

终端里会启动固定域名站点（你在 DNS 设置的域名），同事可直接访问。
说明：`CLOUDFLARE_TUNNEL_MODE=stable` 会在缺 token 时直接报错，不会退化到 Quick Tunnel。

你也可以把服务装进 launchd 后台（重启后也能自动启动）：

```bash
launchctl bootout gui/$(id -u) com.shifeng-investment.cloudflare-tunnel >/dev/null 2>&1 || true
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.shifeng-investment.cloudflare-tunnel.plist"
```

### 2) 快速演示版（Quick Tunnel）

如果你临时想发一个临时口子，可以直接用：

```bash
unset CLOUDFLARE_TUNNEL_TOKEN
unset CLOUDFLARE_TUNNEL_TOKEN_FILE
unset CLOUDFLARE_TUNNEL_ENV_FILE
export CLOUDFLARE_TUNNEL_MODE=quick
export CLOUDFLARE_TUNNEL_TRANSPORT_PROTOCOL=auto
npm run public:tunnel
```

它会走临时 `https://*.trycloudflare.com`，特点是：

- 链接每次会变；
- 需要你本机和终端窗口保持存活。

> Stable 模式更稳，Quick Tunnel 仅作为备用/应急使用。

## 开发说明

This project uses React + TypeScript + Vite.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
