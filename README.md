# 石锋资产投研平台

## AI 投资看板配置

AI 看板位于 `/ai-dashboard`，沿用网站现有访问边界，不再要求单独输入访问口令。看板已停止读取飞书；增长、价格、融资、官网模型卡、算力租赁等板块由服务端从登记过的公开网页读取，每条记录保留来源、口径、数据日期和同步状态。

OpenRouter 只用于公开 Token 流量。若要读取完整的日度排名数据并计算周环比，可配置：

```bash
export OPENROUTER_API_KEY='sk-or-v1-xxx'
```

本地开发也可以将同名变量写入仓库根目录的 `.env.local`；`npm run server` 会自动加载该文件，且该文件已被 Git 忽略。系统环境变量优先于 `.env.local` 中的同名配置。未配置 OpenRouter key 时，页面可以读取本地保存的公开榜单 Top 10，但不会把 Top 10 合计冒充全平台总量，也不会伪造周环比。

### Benchmark 数据边界

Benchmark 不使用 OpenRouter Benchmark API、飞书、Artificial Analysis、Design Arena 或其他公开测评机构补分。它只读取 12 家厂商控制的模型卡、系统卡、发布页、官方 GitHub/Hugging Face 组织：

- Anthropic：`anthropic.com/system-cards`
- OpenAI：`deploymentsafety.openai.com`
- Gemini：`deepmind.google/models/model-cards`
- 智谱：`docs.bigmodel.cn`
- MiniMax：`github.com/MiniMax-AI`
- Qwen：`huggingface.co/Qwen` 与 `github.com/QwenLM`
- MiMo：`github.com/XiaomiMiMo`
- DeepSeek：`github.com/deepseek-ai`
- Kimi：`github.com/MoonshotAI`
- Meta：`developer.meta.com/ai/models`
- Tencent：`github.com/Tencent-Hunyuan`
- xAI：`x.ai/news`

每家只展示当前确认的最新旗舰/通用文本模型。官网未披露分数时显示“未披露”，读取失败时仅保留该厂商上一版官网结果并标旧，不会拿旧模型或另一家数据顶替。同一测试名、版本、split、分数口径的披露合并到一个展示分项；同一模型存在多个运行配置时全部保留并标记歧义。Agent 类冠军要求 Agent、Harness、推理强度、shots/Pass@k 和工具策略逐字段一致；非 Agent 类仅在至少两家披露同一精确测试、未明确标注配置不完整且已披露配置不冲突时生成严格冠军。其他共享分项只显示“官网披露最高值 · 非严格横比”。Terminal-Bench 始终放在 Agent 类别首位，2.0、2.1、3.0 不合并。Fable 与 Mythos 不做名称排除。

进入 Benchmark 页签时会强制触发一次仅限官网模型卡的刷新；并发刷新会合并为同一个请求。所有公开来源每日检查一次，快照原子写入 `server/data/ai-dashboard/snapshot.json`。这些同步请求只读网页，不调用模型推理，也不产生模型 Token 费用。

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
