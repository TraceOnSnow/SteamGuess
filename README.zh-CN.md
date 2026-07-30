# SteamGuess

SteamGuess 是一个 Wordle 风格的 Steam 游戏猜谜网页。玩家每局有 10 次机会，根据国区常态价格、近 7 日/昨日峰值、评测数、好评率、发行日期、厂商和用户标签逐步找出答案。

## 一、当前功能

- 正式题库为 **1964 款 `type=game` 的游戏**；内部候选与标注目录为 1999 条。
- 支持中英文游戏名搜索、键盘选择、重复猜测排除和自定义题库 AppID。
- 可配置显示价格、活跃度、好评率、发行日期、是否拥有、厂商和用户标签。
- 截图提示只使用题库已有的 `hints.screenshotUrl`；猜题结束后显示原图。
- 游戏结束后可以提交 0–100 难度分数及简单/普通/困难/地狱等级。
- 可导入本地 AppID 文件，或通过服务端导入公开 Steam 个人游戏库。

## 二、技术与目录

- 前端：React 19、TypeScript 5.9、Vite 7、i18next。
- 后端：Node.js HTTP 服务与 Node 内置 SQLite。
- `public/games_demo.json`：1964 款正式题库。
- `public/labeling_catalog.json`：1999 条内部标注候选。
- `server/`：API、数据库迁移、限流、静态文件服务。
- `data/runtime/`：运行时 SQLite，禁止提交并必须持久化。

内部标注器在开发环境可用，生产构建默认关闭。只有显式设置 `VITE_LABELER_ENABLED=true` 才会暴露 `/labeler`。

## 三、本地运行与检查

```bash
npm ci
npm run dev
```

完整上线检查：

```bash
npm run release:check
```

它会依次运行 ESLint、前后端测试、数据测试、生产构建和上线前检查。单独命令：

```bash
npm run test
npm run test:data
npm run build
npm run release:preflight
```

## 四、生产部署

复制配置并启动 Node 服务：

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

默认监听 `0.0.0.0:4173`，健康检查为 `/api/health`。推荐使用 Compose：

```bash
docker compose up -d --build
docker compose ps
```

Compose 会把 `/app/data` 挂载到 `steamguess-data` volume。反向代理必须只在确实由可信代理转发时设置 `STEAMGUESS_TRUST_PROXY=true`。

主要环境变量：

```env
STEAM_WEB_API_KEY=                 # 导入公开 Steam 库时需要，只能放服务端
STEAMGUESS_DB_PATH=                # 默认 data/runtime/steamguess.sqlite
STEAMGUESS_TRUST_PROXY=false
STEAMGUESS_WRITE_RATE_LIMIT=60     # 每 IP 每分钟写请求
STEAMGUESS_PROFILE_RATE_LIMIT=12   # 每 IP 每分钟 Steam 库导入请求
VITE_LABELER_ENABLED=false         # 构建期变量，线上保持 false
```

## 五、数据更新

本次已把 SteamSpy 前两页 1999 条候选发布为 **1964 款可玩游戏**：中文名 1963 款，国区常态价格 1704 款，已有截图 890 款。非游戏 application、tool、DLC、demo 等不会进入正式题库。

```bash
# 将当前 JSON 目录幂等导入持久化 catalog SQLite
npm run data:catalog-import
npm run data:catalog-status

# 使用已有候选数据重新发布浏览器文件，不联网
npm run data:publish-labeler
npm run data:publish-playable

# 每日记录 SteamSpy 前两页的昨日峰值，形成滚动近 7 日峰值
npm run data:sample-peaks

# 每周抓取 SteamSpy request=all 第 0..19 页并写入 discovery 数据库
npm run data:update-weekly
```

目录数据库 `data/catalog/catalog.sqlite` 与玩家运行时数据库相互独立，完整设计见 `docs/catalog-pipeline.md`。SteamSpy 的 `ccu` 是前一日峰值，不是实时在线。累计采样后页面显示近 7 日峰值；样本不足时降级显示昨日峰值。常态价格只读取国区原价，不使用促销价，也不把美元价格换算成人民币。

PICS 验证工具的 `steam-user` 依赖已从主项目隔离，避免进入生产安装和镜像：

```bash
npm run pics:install
npm run pics:tags -- 730 --language schinese
```

## 六、SQLite、备份与反馈

数据库首次访问时自动创建并按 `schema_migrations` 顺序迁移。服务器若遇到比自身更新的数据库版本会拒绝启动，避免旧程序破坏新数据。

```bash
# 一致性备份，默认保留 14 份
npm run db:backup

# 查看玩家、对局、结局和难度反馈统计
npm run db:stats
```

可用 cron 每天备份：

```cron
15 3 * * * cd /srv/SteamGuess && /usr/bin/npm run db:backup >> /var/log/steamguess-backup.log 2>&1
```

备份目录默认是 `data/backups/`。上线前应实际执行一次恢复演练，并把备份同步到服务器之外。

## 七、安全与接口

- POST 写接口默认每 IP 60 次/分钟，Steam 库导入默认 12 次/分钟；超限返回 `429`。
- JSON 请求体上限 32 KB；Steam 上游请求超时 12 秒。
- 生产服务已设置 CSP、禁止 MIME 嗅探、禁止 iframe、Referrer Policy 和 Permissions Policy。
- `STEAM_WEB_API_KEY` 不会进入前端构建；用户的 Steam“游戏详情”必须公开。
- 根目录 `token` 已忽略。若真实密钥曾经提交到 Git 历史，必须在对应服务撤销并轮换。
- PICS PoC 的旧依赖存在上游审计告警，但它位于独立工具目录，不属于主项目依赖，也不会进入生产 Runtime 镜像。主项目 `npm audit` 应为 0。

## 八、初版上线清单

1. 配置域名、HTTPS、反向代理和 `STEAM_WEB_API_KEY`。
2. 挂载持久化 `/app/data`，确认容器重建后 SQLite 不丢失。
3. 执行 `npm run release:check`，再访问 `/api/health`。
4. 实测中文搜索、1964 款题库加载、自定义 AppID 和公开 Steam 库导入。
5. 实测有截图和无截图游戏的提示状态，以及未知价格/发行日期显示 `—`。
6. 配置每日数据库备份和每周数据更新任务。
7. 上线初期观察 429、502、数据库体积、反馈提交失败率和页面加载时间。
8. 暂不开发排行榜和多人模式，但保留现有 player/session schema 作为后续基建。
