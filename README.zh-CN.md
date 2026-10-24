# SteamGuess

**当前验收版：300 款。** 答案池按固定热度排名选择 300 款游戏，搜索和猜测范围扩展到 2,000 款；约 1.97 万条历史记录作为数据档案保留。

- 单人保留属性比对猜游戏，支持每日挑战和自由练习。
- 搜索库与答案池独立：2,000 款游戏均可搜索、提交比对，只有固定的 300 款能出题。搜索结果不显示答案资格，首页也不直接列出答案名单。
- 入门 / 简单 / 普通 / 困难 / 地狱使用 20 / 50 / 100 / 200 / 300 款累计题库；所有难度均为十次机会，截图提示随时可用。
- 提示为一张模糊截图，可手动变清晰；猜中、用尽次数或揭晓答案后自动显示清晰截图。没有评论或印象描述提示。截图、价格和评测数字来自恢复时的数据快照。
- 今日同题按设备日期更新；本机自动续局、统计战绩、复制不含答案的分享文字。
- 多人支持 2–8 人私人房间，使用同一套五档累计题库，均为 120 秒和十次猜测。

```bash
npm ci
npm run build
npm start
# 浏览器打开 http://localhost:4173
```

直接克隆即可运行；随仓题库不依赖 API Key 或外部数据库备份。如需恢复可编辑的本地 catalog：

```bash
npm run data:restore
npm run release:check
```

`data:restore` 优先使用本地恢复备份；没有备份时从随仓快照建立 SQLite，保留已有人工评分并在修改前备份。名单和固定分档在 `data/curated/classics.json`，发布器统一生成前后端共用的 `public/games_demo.json`。本机原始恢复备份位于被 Git 忽略的 `data/backups/recovery-20261022/`，应另行备份。

初次选取使用 `npm run data:select-classics`：从恢复数据中按既有热度权重取 300 款，要求有发行日期、标签和截图，并合并同名不同版本；日常运行无需重选。数量统一配置在 `shared/edition.json`。

五档划分随版本固定在 `data/curated/classics.json`，前台和多人均按发布快照筛选（未评分的搜索库条目永不成为答案）；后台评分与玩家反馈不会改变精选版题库。当前恢复数据没有 IGDB primitives，初始分档明确标为 `steamspy-weighted-frozen`：使用已有的 SteamSpy 85% 评测量 / 15% 峰值（对数归一化）加权排序，仅在选定的 300 款中累计截取 20 / 50 / 100 / 200 / 300 款，不能冒充 IGDB 分数。

项目最后的 IGDB 原公式保留在 `scripts/catalog/rank_igdb_heat.py`：Played 31.25%、Playing 31.25%、Total Reviews 12.5%、24hr Peak Players 12.5%、Visits 12.5%。拿到原公式输出的完整排名快照后，可以一次性替换分档：

```bash
npm run data:freeze-difficulty -- --igdb-ranking /path/to/igdb-heat-all.json
# 名称无法唯一对应时增加 --igdb-mapping /path/to/appid-to-igdb.json
npm run data:restore
npm run build
```

导入缺失或歧义会报错并保留上一份分档，不会悄悄填充 Steam 分数。该操作仅在主动发布时执行，不需要常驻评分服务或动态维护。

周更入口默认只重建精选版本，不再自动扩充题库。历史批量发现流程需显式设置 `STEAMGUESS_EDITION=archive`。图片由 Steam CDN 提供；首张失败时自动尝试下一张，全部失败可重试，仍可继续属性比对。

以下为保留的数据平台和历史运维说明；涉及排名窗口与五档题池的旧规则不适用于当前精选前台。


> 一个面向 Steam 游戏的猜游戏网页：用结构化线索逐步缩小答案，也为多人竞技和持续更新的数据平台打基础。

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-7-646cff?logo=vite&logoColor=white)](https://vite.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-5fa04e?logo=node.js&logoColor=white)](https://nodejs.org/)

[English](README.md)

SteamGuess 是一个类似 Wordle 的 Steam 游戏猜测游戏。玩家可以使用中文或英文搜索游戏名称，然后根据国区常态价格、玩家峰值、评测数据、发行日期、开发商/发行商和 Steam 用户标签逐步猜出答案。

项目分为两个相互独立但共享数据的部分：

- **可玩产品**：面向玩家的轻量 Search 搜索库，其中带有效难度的游戏构成答案池。
- **数据与反馈平台**：持久化 catalog、增量数据补全、难度反馈以及多人模式基础设施。

## 产品入口

| 入口 | 说明 |
| --- | --- |
| `/` | 首页模式选择：单人或多人 |
| `/singleplayer` | 单人猜游戏，支持线索设置和提示 |
| `/multiplayer` | 2–8 人私人房间同题竞速 |
| `/labeler` | 内部 SQLite 难度管理工具，生产环境默认关闭 |
| `/api/health` | 服务健康检查 |

### 当前功能

- 中文/英文游戏名搜索和键盘操作。
- 最多十次猜测，自动阻止重复猜测。
- 简单、普通、困难、地狱四个预制难度题库。
- 支持上传 AppID 或导入公开 Steam 个人资料建立自定义题库。
- 国区人民币常态价格；促销价明确不参与统计。
- 有采样数据时显示近七日玩家峰值；SteamSpy 的 `ccu` 被视为历史峰值，不是实时在线人数。
- 根据 catalog 中已有数据展示截图提示和评论提示。
- 游戏结束后支持 0–100 难度评分，也支持选择预制难度。
- 服务端持久化游戏会话、结果和玩家反馈。
- 多人房间支持房间码、一键复制、准备状态、服务端权威结算、投降、再来一局和短时断线恢复。

## 技术架构

```text
SteamSpy request=all ─┐
Steam Storefront API ─┼─> catalog JSON ─> catalog SQLite ─> 浏览器题库
Steam Reviews API ────┤              └─> 增量任务 checkpoint
Steam PICS（可选）───┘

浏览器 ──HTTP API──> Node.js 服务 ──> runtime SQLite
        Socket.IO ──> 多人房间引擎
```

| 模块 | 目录 | 职责 |
| --- | --- | --- |
| 前端 | `src/` | React 界面、游戏引擎、搜索、提示、设置、多人客户端 |
| HTTP/API 服务 | `server/` | 静态文件、API、限流、迁移、运行时持久化 |
| Catalog 流水线 | `scripts/catalog/` | 抓取、规范化、补全、发布、导入、状态检查 |
| 运维脚本 | `scripts/ops/` | 周更入口、发布校验、备份和 smoke test |
| 浏览器数据 | `public/` | 浏览器运行时游戏题库快照 |
| 文档 | `docs/` | 数据流水线、数据结构、标注器、多人模式和部署说明 |

Catalog 数据库与玩家运行时数据库相互独立，数据更新不会直接影响玩家会话和反馈。

## 快速开始

环境要求：Node.js 24+、npm；运行 catalog 脚本还需要 Python 3.12+。

```bash
npm ci
npm run dev
```

打开 Vite 输出的地址，根路径 `/` 会先进入模式选择页。也可以直接访问：

```text
/singleplayer
/multiplayer
```

运行接近生产环境的 Node 服务：

```bash
npm run build
npm start
```

默认监听 `0.0.0.0:4173`。

## 质量检查

发布前运行完整检查：

```bash
npm run release:check
```

它会执行前端 lint、前后端测试、数据流水线测试、TypeScript 编译、生产构建和部署前检查。常用的单项命令：

```bash
npm run lint
npm test
npm run test:data
npm run build
npm run release:preflight
```

## Catalog 数据流水线

浏览器使用发布后的 Search 快照；其中带有效难度的条目才可以被选为答案。
每周更新是增量且可恢复的：

1. 抓取 SteamSpy `request=all` 前 20 页，即 page `0..19`。
2. 按唯一 AppID 规范化、去重并保留原始来源信息。
3. 前 `1,000` 款符合排名窗口条件的条目进入 Active，后续候选保留为 Reserve。
4. 对前 `4,000` 款 Detail 条目补齐缺失的 PICS、Storefront 和评论数据。
5. 每个原始页面和补全任务都保存 checkpoint。
6. 发布 Search 数据、派生带难度的答案池，校验 membership 后原子替换正式数据。
7. 失败时保留 staging 和上一版正式快照，不发布半成品。

运行时固定关系：

```text
Playable 答案池 ⊆ Search 搜索库 ⊆ Active 排名窗口
```

生产周更入口：

```bash
./scripts/ops/run_weekly_catalog.sh
```

默认参数：

```text
SteamSpy 页面：              0..19
SteamSpy 页面间隔：          120 秒
Storefront 请求间隔：        5 秒
评论请求间隔：               5 秒
SteamSpy 单页重试：          2 次
评论重试：                   3 次
Active catalog 上限：        1,000 款
Detail 补全上限：            4,000 款
```

如果任务失败，保留目录：

```text
data/catalog/.weekly-work/current
```

再次运行同一个入口即可从已有 checkpoint 继续，不会重新抓取已经成功的页面。

常用覆盖参数：

```bash
STEAMGUESS_ACTIVE_LIMIT=1000
STEAMGUESS_DETAIL_LIMIT=4000
STEAMGUESS_STEAMSPY_INTERVAL=120
STEAMGUESS_STEAMSPY_RETRIES=2
STEAMGUESS_STEAMSPY_RETRY_DELAY=30
STEAMGUESS_STOREFRONT_DELAY=5
STEAMGUESS_REVIEWS_DELAY=5
STEAMGUESS_REVIEWS_RETRIES=3
STEAMGUESS_REVIEWS_RETRY_DELAY=30
```

详细说明见：[`docs/data-pipeline.md`](docs/data-pipeline.md)、
[`docs/catalog-pipeline.md`](docs/catalog-pipeline.md)、
[`docs/data-schema.md`](docs/data-schema.md) 和
[`docs/chinese-game-names.md`](docs/chinese-game-names.md)。

## 数据库和生产运维

数据库迁移通过 `schema_migrations` 表跟踪。若服务发现数据库版本高于当前代码支持的版本，会拒绝启动，避免旧程序破坏新数据。

```bash
npm run db:backup
npm run db:backup-catalog
npm run db:stats
npm run data:catalog-status
```

生产环境需要持久化 `data/`，配置定期备份，把备份复制到服务器之外，并在上线前实际演练一次恢复。Catalog 数据库不再以压缩 bootstrap 文件提交到 Git：它体积大、会持续变化，而且过期快照曾让旧 schema 和旧 Labeler 数据在新机器上重新出现。迁移机器时应传输 `db:backup-catalog` 生成的备份，或恢复生产数据卷。

Docker Compose 示例：

```bash
docker compose up -d --build
docker compose ps
```

## 配置与安全

```bash
cp .env.example .env
```

`STEAM_WEB_API_KEY` 只放在服务端，用于导入公开 Steam 个人资料/游戏库；评论接口不依赖这个 Key。不要将它写入前端代码，也不要提交到 Git。

服务端包含请求体大小限制、写接口和资料导入限流、上游请求超时、安全响应头以及 SQLite 迁移保护。只有在服务确实位于可信反向代理之后时，才设置：

```env
STEAMGUESS_TRUST_PROXY=true
```

内部难度管理工具在生产环境需要显式打开，并配置服务端管理员 Token：

```env
VITE_LABELER_ENABLED=true
STEAMGUESS_ADMIN_TOKEN=请替换为高强度密钥
```

## 多人模式状态

多人 MVP 当前支持 2–8 人私人房间、BO1/BO3/BO5、准备状态、房间码分享、服务端选题和结算、回合计时、投降、再来一局以及短时间断线恢复。

Docker Compose 现在默认启用 Redis。同一台机器上的多个 Node.js 进程可以共享活动房间、Socket.IO 广播、房间锁和断线恢复状态；未配置 Redis 的本地开发环境会回退到单进程 `MemoryRoomStore`。

当前 Redis 有意关闭了磁盘持久化，因此 Redis 或整机重启仍会结束活动房间。权威房间状态提交后的 SQLite 完赛记录目前也是 best-effort；跨整机重启的持久恢复、结果 outbox、排行榜、匹配系统和社交功能暂不属于当前范围。

多人模式设计记录见 [`docs/multiplayer-research.md`](docs/multiplayer-research.md)。

## 路线图

- [x] 单人猜游戏流程和五档难度题库
- [x] 玩家反馈和 catalog SQLite 持久化
- [x] 可恢复的每周 catalog 更新
- [x] 截图/评论提示接口
- [x] 多人模式 MVP 基础设施
- [x] Redis 共享多人房间状态与跨实例断线恢复
- [ ] 更完整的中文元数据和评论覆盖
- [ ] 跨整机重启的房间恢复与可靠结果 outbox
- [ ] 匹配系统、排行榜和社交功能

## 数据来源与版权

SteamGuess 代码与生成数据分开维护。Steam 的游戏元数据、图片、标签和评论受各自服务条款与版权约束。重新发布上游数据前，请确认对应服务的使用和再分发条款。
