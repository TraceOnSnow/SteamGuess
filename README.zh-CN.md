# SteamGuess

**在线游玩：** https://steamguess.traceonsnow.com · [English](README.md) · 作者 [TraceOnSnow](https://traceonsnow.com)

十次机会猜出一款 Steam 游戏。搜索并提交一款游戏后，它会和答案逐项比较：价格、单日在线峰值、评测数、好评率、发行时间、厂商和标签。颜色表示每项离答案多近，箭头表示答案在哪个方向。随时可以打开一张模糊截图作为提示。

- **每日挑战**：所有人同一题，本地时间零点更新。
- **自由练习**：选难度或主题预设，不限局数；可以复制分享链接，让朋友猜同一款。
- **多人房间**：2–8 人同题竞速。
- 中英文界面。中文界面比较国区人民币价格，英文界面比较美区美元价格。

## 运行

需要 Node.js 24 或更高版本。

```bash
npm ci
npm run build
npm start
```

服务监听 `http://localhost:4173`。开发时用 `npm run dev`，支持热更新。新 clone 的仓库可以直接运行：游戏数据已经提交在仓库里，不需要任何 API key。

## 项目结构

| 路径 | 内容 |
| --- | --- |
| `src/` | React 前端：页面、猜测卡片、搜索、截图提示 |
| `shared/game-rules.js` | 比较阈值、难度分档和每日选题，前后端共用 |
| `shared/edition.json` | 题库和各档的大小 |
| `server/` | Node HTTP 服务、JSON 接口、SQLite 存储、Socket.IO 房间 |
| `public/games_demo.json` | 所有可搜索的游戏及其线索数据 |
| `data/curated/answers.json` | 题库：哪些游戏、各在哪一档 |
| `scripts/catalog/` | 抓取和重建数据用的一次性 Python 工具 |

路由：`/` 首页，`/singleplayer`（加 `?daily=1` 是每日挑战），`/multiplayer`，`/api/health`。

## 题库和难度

约 2000 款游戏可以被搜索和猜测，其中 1000 款可以成为答案。难度是累加的：

| 难度 | 数量 | 含义 |
| --- | --- | --- |
| 入门 | 20 | 几乎人人都认识 |
| 简单 | 50 | 热门大作 |
| 普通 | 100 | 常见游戏 |
| 困难 | 300 | 需要一点阅历 |
| 地狱 | 1000 | 全部游戏，含未经验证的长尾 |

每日挑战和多人房间只从"困难"及以下出题。"地狱"只在单人模式可选；如果这一局的答案来自长尾部分，结束后会问玩家这道题是否合适。

入门、简单、普通三档是按中文玩家的知名度人工挑选的；困难档以热度分为底，再人工增删；其余进入地狱档。热度分来自 SteamSpy 快照：`0.85 × log(评测数) + 0.15 × log(同时在线)`，两项各自按最大值归一化。人工分档写在 `data/curated/overrides.json`。

自由练习除了按难度，还可以选预设题库：

- **TGA 提名**：近 10 届 TGA 年度游戏提名中在 Steam 上发售的游戏。名单在 `data/curated/tga.json`，每年颁奖后手动加一行。
- **MC 80+**：题库中 Metacritic 评分 80 分以上的游戏，分数来自 Steam 商店。
- **自定义**：玩家粘贴或上传一个 JSON，例如 `{"name": "我的列表", "appIds": [730, 570, 292030]}`，也可以直接写 AppID 数组。列表只存在玩家浏览器里，可以下载成文件分享。不在 1000 款题库里的游戏也能出题，只是没有截图提示。

每一局结束都会记录答案、结果、猜测次数和是否用了提示。查看每道题的实际表现：

```bash
npm run db:stats -- --min 10 --level unrated
```

据此修改 `data/curated/answers.json` 里的 `level` 或删掉某一条，然后运行 `npm run data:build`。

## 数据

游戏数据是冻结的快照，不是实时数据。来源：

| 来源 | 提供的内容 |
| --- | --- |
| SteamSpy | 游戏名单、评测数、同时在线人数、用户标签 |
| Steam 商店接口 | 中英文名、发行日期、美元和人民币原价、截图、厂商 |
| Steam 商店页和热门榜 | SteamSpy 没有数据的知名游戏的评测数和标签 |
| 人工维护（`data/curated/`） | 商店缺失的中文名（`zh_names.json`）、TGA 提名（`tga.json`）、补充游戏（`supplement.json`） |

价格是原价，不含折扣。某个地区不再销售的游戏在该地区显示"未售"。在线人数是历史数值，不是实时人数。

刷新数据（受限速影响，大约需要两小时）：

```bash
npm run data:fetch             # 抓取每款游戏的商店数据，可断点续跑
npm run data:fetch-supplement  # data/curated/supplement.json 里的游戏，加上 Steam 当前热门榜
npm run data:build             # 重建 public/games_demo.json；加 -- --reselect 会重新选题库
```

抓取进度保存在 `data/processed/`。不加 `--reselect` 时保留现有题库和分档。

## 测试和发布

```bash
npm run release:check
```

它会依次运行代码检查、前后端测试、数据工具测试、生产构建，并检查发布的数据是否与 `shared/edition.json` 一致。本机没有 Redis 时，Redis 多人测试会跳过。

## 部署

`Dockerfile` 构建单个镜像；`compose.yaml` 和 `compose.production.yaml` 连同 Redis 一起运行。`.github/workflows/deploy-production.yml` 在推送时构建并部署。配置项见 `.env.example`，全部可选。运行数据在 `data/runtime/steamguess.sqlite`，用 `npm run db:backup` 备份。

本项目与 Valve 无关，游戏图片归各自权利人所有。
