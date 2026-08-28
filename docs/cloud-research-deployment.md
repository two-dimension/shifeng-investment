# 公告监控云端部署

公告监控由 GitHub Actions 运行四套 Python 任务，Cloudflare Worker 承载网站和 API，D1 保存摘要，R2 保存 PDF/Excel。部署完成后，公告监控不依赖本机或本机 Tunnel。

## 1. Cloudflare 资源

项目配置使用以下资源：

- Worker：`shifeng-investment`
- D1：`shifeng-research`
- R2：`shifeng-research-reports`

先登录 Wrangler，然后创建资源并把实际 ID 填入 `wrangler.jsonc`。已有资源时不要重复创建。

```bash
npx wrangler login
npx wrangler d1 create shifeng-research
npx wrangler r2 bucket create shifeng-research-reports
npm run cf:migrate:remote
```

## 2. Cloudflare 密钥

生成一个随机发布密钥。相同的值要分别保存到 Cloudflare 和 GitHub，不能写入仓库。

```bash
npx wrangler secret put GITHUB_DISPATCH_TOKEN
npx wrangler secret put RESEARCH_PUBLISH_TOKEN
```

`GITHUB_DISPATCH_TOKEN` 使用只针对当前仓库的 GitHub fine-grained token，并只授予触发 `repository_dispatch` 所需的仓库 Contents 写权限。

## 3. 首次部署

```bash
npm ci
npm run test:worker
npm run deploy:cloud
```

Wrangler 会输出 Worker 的 HTTPS 地址。先保留该地址，后面把它保存为 GitHub Secret `CLOUD_RESEARCH_BASE_URL`。

## 4. GitHub Actions 密钥

在 GitHub 仓库的 `Settings → Secrets and variables → Actions` 中创建：

- `CLOUD_RESEARCH_BASE_URL`：上一步 Worker 的 HTTPS 地址；
- `RESEARCH_PUBLISH_TOKEN`：与 Cloudflare 中完全相同的发布密钥。

`.github/workflows/cloud-research.yml` 必须进入默认分支，Worker 发出的 `repository_dispatch` 才能启动它。工作流也支持 GitHub 页面手动运行，并在工作日北京时间 22:35 自动运行。

## 5. 迁移历史公告

迁移脚本支持断点续传和重复执行。这里使用新电脑代码库中已经恢复的历史数据目录：

```bash
export RESEARCH_DATA_DIR='/绝对路径/server/data/research'
export RESEARCH_REPORTS_DIR='/绝对路径/server/public/reports'
export CLOUD_RESEARCH_BASE_URL='https://实际-worker-地址'
export RESEARCH_PUBLISH_TOKEN='与-cloudflare-相同的密钥'
node server/scripts/migrate_research_history.mjs
```

进度保存在被 Git 忽略的 `server/.cloud-research-migration-checkpoint.json`。中断后执行同一命令即可继续；D1 摘要采用 upsert，R2 同名文件采用覆盖写入。

## 6. 域名和旧功能

将正式网站域名绑定到 Worker 后，电脑关机时网站外壳和公告监控仍可访问，不需要 Tunnel。

其他尚未云化的本地 API 可以暂时使用另一个 Tunnel 源站域名，并把该地址写入 `wrangler.jsonc` 的 `LEGACY_API_ORIGIN`。它不能与 Worker 正式域名相同，否则会形成循环。电脑离线时这些旧功能返回明确的 `503`，不会显示成伪造的空数据。

## 7. 验收

把 Wrangler 输出的真实地址设为临时变量：

```bash
export SHIFENG_CLOUD_HOST='https://实际-worker-地址'
curl -fsS "${SHIFENG_CLOUD_HOST}/api/research/cninfo/latest"
curl -fsS -X POST "${SHIFENG_CLOUD_HOST}/api/research/refresh"
curl -fsS "${SHIFENG_CLOUD_HOST}/api/research/refresh/status"
```

连续两次请求刷新时只应出现一个活动任务。完整任务失败时，D1/R2 中上一次成功数据必须继续可读。

## 8. 回滚

如果新站点需要回滚，把正式 DNS 主机名恢复到原来的 Named Tunnel 即可。不要删除 D1、R2 或迁移检查点；它们不影响旧站，并可用于再次部署。

Cloudflare 和 GitHub 都有免费额度，但不是无限免费；实际用量和是否产生超额费用以账号控制台为准。
