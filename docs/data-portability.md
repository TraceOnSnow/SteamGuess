# SteamGuess 数据保留与迁移说明

> 本文档记录当前工作区中哪些内容已经进入 Git、哪些内容需要单独备份，以及在另一台机器上如何恢复开发环境。  
> 当前策略是：Git 保存代码和可重建流程；数据库、原始响应和密钥在 Git 之外保存。

## 结论

截至当前提交 `004f200`：

- 代码、脚本、数据库 schema、数据管线文档、测试、前端、服务端和多人模式改动已经提交并推送；
- 当前本地数据库没有提交，但这是有意的：`data/catalog/catalog.sqlite` 约 819 MiB，且 `.gitignore` 已将 SQLite 数据库排除；
- 当前未提交的 SteamSpy JSON 约 246 MiB，不能直接提交到 GitHub；
- 当前未提交的 `data/analysis/` 约 32 MiB，属于实验分析结果，不是应用运行必需数据；
- 因此，换机器时不能只执行 `git clone`；需要额外复制数据库、备份、必要的原始数据，并重新配置密钥。

## 当前未提交内容

### 1. `data/catalog/steamspy_top_2000.json`

- 状态：已被 Git 跟踪，但本地有未提交修改；
- 大小：约 246 MiB；
- 内容：SteamSpy Top 2000 的实验性排名/候选数据；
- 结论：不要提交这次修改。文件超过 GitHub 常规单文件限制，而且它不是当前 IGDB + PICS 主流程的唯一数据源。
- 如果要保留：将当前文件复制到外部备份或对象存储，并记录生成时间和使用的脚本参数。

### 2. `data/analysis/`

未提交的内容主要包括：

- IGDB popularity 各分类的样本、Top 3000/Top 500 抓取结果；
- IGDB 热度合并和补全结果；
- SteamSpy 加权排名实验结果；
- IGDB Played Top 10 的详细调查；
- 热度分析用的 checkpoint；
- `.~lock.*` LibreOffice 临时锁文件。

这些文件用于分析和复盘，不参与网站运行，也不是当前数据库恢复的必要输入。建议：

- 删除或忽略 LibreOffice 的 `.~lock.*` 文件；
- 需要保留实验结论时，优先保留 Markdown 报告和最终 CSV；
- 需要完整复现实验时，再将整个 `data/analysis/` 目录打包到外部存储；
- 不要把这些临时实验结果混入应用发布提交。

## 必须单独保留的数据

### A. 当前数据库

```text
data/catalog/catalog.sqlite
```

当前本地数据库概况：

```text
games              19,704
pool_status=eligible 19,664
pool_status=excluded    40
pool_status=search_only 0
raw_pics_json      19,704
```

当前 40 条排除记录的原因均为 `non_game_type`。当前数据库中的难度字段尚未重新初始化：

```text
difficulty_score       0
difficulty_manual_score 0
difficulty_locked      0
```

数据库是当前最方便的开发快照。虽然它可以通过 API 重新构建，但重新构建会受到 API 可用性、限流、数据变化和匹配结果变化的影响。因此，在迁移到新机器前至少复制这一份。

### B. 数据库备份

```text
data/backups/
```

当前目录包含多个历史 SQLite/JSON 快照。它们被 `.gitignore` 排除，不能依赖 Git 恢复。迁移时应保留至少：

1. 当前 `data/catalog/catalog.sqlite`；
2. 最近一次可验证的 catalog SQLite 备份；
3. 如需回滚，再保留对应的 `games_demo.json` 或 catalog JSON 快照。

### C. 原始数据

```text
data/raw/
```

其中包括 SteamSpy 页面响应和 PICS 响应。原始数据不是每次恢复都必须，但它们可以在 API 变化或限流时帮助重建、调试和核对结果。至少建议保留：

```text
data/raw/pics/
data/raw/steamspy/
```

### D. 本地密钥和运行配置

```text
.env.local
```

该文件不应提交。迁移时在新机器上手动重新创建，并从 `.env.example` 对照配置。可能涉及的密钥包括：

```text
STEAM_WEB_API_KEY
IGDB_CLIENT_ID
IGDB_CLIENT_SECRET
```

不要将真实值写入本文档、Git、日志或公开的 issue。

## 已经在 Git 中的内容

当前提交已经包含恢复项目所需的主要工程内容：

- 前端和服务端代码；
- 单人猜谜、多人模式和 API；
- catalog schema、数据库访问和导入脚本；
- IGDB popularity 获取、分析、补全和排序脚本；
- PICS、SteamSpy 及其他数据管线脚本；
- 周更入口和断点续读逻辑；
- 难度反馈同步、迁移和发布脚本；
- 数据管线、schema、中文名和多人模式文档；
- 单元测试、服务端测试、类型检查、lint 和构建配置；
- `public/games_demo.json` 等发布所需的代码仓库快照。

这些内容可以通过 Git 恢复，不需要提交本地生成的 SQLite 文件。

## 可以重新生成的内容

以下内容理论上都可以从代码和 API 重新生成：

- IGDB 游戏基础元数据和 popularity 数据；
- PICS 标签、应用类型和 Steam 关联信息；
- SteamSpy 候选排名；
- catalog JSON、SQLite 导入结果和 `public/games_demo.json`；
- 热度排名分析表；
- 运行期间产生的 checkpoint。

但“可以重新生成”不代表“应该丢弃”。API 返回值会变化，且重新抓取可能失败。因此在新管线成功完成一次小规模验证前，不建议删除当前数据库和原始数据。

## 新机器迁移步骤

在新机器上：

```bash
git clone <repository>
cd SteamGuess
npm install
```

然后：

1. 从外部备份复制 `data/catalog/catalog.sqlite`；
2. 按需复制 `data/backups/` 和 `data/raw/`；
3. 从 `.env.example` 创建 `.env.local`，填入新的密钥；
4. 运行 catalog 状态检查：

   ```bash
   python3 -m scripts.catalog.status \
     --db data/catalog/catalog.sqlite
   ```

5. 启动前端和服务端，确认搜索、单人模式、多人模式和数据库读取正常；
6. 先用小规模参数运行新的 IGDB + PICS 管线，再考虑执行完整更新；
7. 新管线通过验证后，再决定是否把旧 SteamSpy/Storefront/Reviews 数据归档。

## 当前数据策略和边界

后续数据库收敛方向是：

- IGDB ID 作为最终游戏记录的严格主键；
- Steam AppID 作为可空的外部关联字段；
- 没有 Steam AppID 的 IGDB 游戏也可以保留并参与搜索/题库，具体由池状态决定；
- 核心数据源收敛为 IGDB + PICS；
- 截图和评论暂时不属于核心重构范围；
- `heat_score`、`heat_rank` 是展示和初始化难度时的辅助数据，不直接决定题库资格；
- 非游戏应用应通过 `pool_status=excluded` 永久排除，而不是被赋予低难度分数；
- 难度分数后续由人工标注和玩家反馈重新设计，不依赖旧回归模型或旧难度历史。

本次文档提交不执行数据库重构，也不删除任何本地生成数据。

## 迁移检查清单

- [ ] 已复制当前 `data/catalog/catalog.sqlite`
- [ ] 已复制最近一次可用的 SQLite 备份
- [ ] 已按需复制 `data/raw/`
- [ ] 已单独保存需要复盘的 `data/analysis/`
- [ ] 已在新机器重新配置 `.env.local`
- [ ] 已运行 `scripts.catalog.status`
- [ ] 已完成一次小规模 IGDB + PICS 验证
- [ ] 已确认 Git 工作区没有意外的密钥或大型数据文件
