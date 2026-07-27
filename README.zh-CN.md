# SteamGuess

一个 Wordle 风格的 Steam 游戏猜谜网页。玩家每局有 10 次机会，通过价格、当前在线人数、评测数量、好评率、发行日期和共同标签逐步找出答案。

当前版本专注于把既有玩法恢复成可靠、可维护的前端基线。题库固定使用 `public/games_demo.json` 中的 903 款游戏；Python 数据抓取流水线暂未纳入本轮维护范围。

## 当前功能

- 每局从 903 款游戏中随机选择答案
- 游戏名称搜索，支持键盘上下选择和 Enter 提交
- 已猜游戏自动排除，避免重复提交
- 最多 10 次猜测
- 价格、在线人数、评测数、好评率、发行日期分级反馈
- 箭头始终表示“答案相对当前猜测应该更高还是更低”
- 共同标签高亮
- 猜中、次数耗尽和主动揭晓三种明确结束状态
- 中英文切换并持久化语言选择
- 响应式布局和基本无障碍支持
- 点击游戏封面前往 Steam 商店

## 技术栈

- React 19
- TypeScript 5.9
- Vite 7
- i18next / react-i18next
- date-fns
- Vitest
- ESLint 10

本项目当前没有后端服务。游戏数据作为静态 JSON 在页面启动时异步加载。

## 快速开始

```bash
npm ci
npm run dev
```

默认开发地址由 Vite 输出，通常为 `http://localhost:5173`。

## 工程检查

```bash
npm run lint
npm run test
npm run build
npm run preview
```

## 前端架构

```text
src/
├── App.tsx                         # 题库加载、游戏阶段和回合状态
├── i18n.ts                         # 中英文文案与语言初始化
├── components/
│   ├── SearchBox/                  # 可键盘操作的游戏搜索
│   └── GameTable/                  # 猜测记录、属性反馈和答案行
├── config/comparison.ts            # 比较阈值
├── data/games.ts                   # 题库加载、搜索和随机选择
├── engine/
│   ├── ComparisonEngine.ts         # 游戏字段比较编排
│   └── FieldComparator.ts          # 数字和日期通用比较
└── types/                          # 游戏与比较结果类型
```

主要数据流：

```text
public/games_demo.json
        ↓ fetch
    App.tsx 选择答案
        ↓
 SearchBox 提交 Game
        ↓
 ComparisonEngine
        ↓
 GuessRecord[]
        ↓
 GameTable 展示线索
```

## 比较规则

阈值定义在 `src/config/comparison.ts`。

### 价格

使用美元价格绝对差：

- `≤ 1`：准确
- `≤ 5`：接近
- `≤ 15`：相邻
- 其他：较远

### 当前在线人数和评测数

使用相对答案值的百分比差：

```text
abs(猜测值 - 答案值) / abs(答案值) × 100
```

- `≤ 5%`：准确
- `≤ 50%`：接近
- `≤ 100%`：相邻
- 其他：较远

答案值为 0 时单独处理，避免除零。

### 好评率

使用百分点绝对差：

- `≤ 1`：准确
- `≤ 5`：接近
- `≤ 10`：相邻
- 其他：较远

### 发行日期

比较完整日期：

- `≤ 0.2 年`：准确
- `≤ 1 年`：接近
- `≤ 3 年`：相邻
- 其他：较远

### 胜负判定

胜负使用 Steam `appId` 判断，而不是游戏名称，因此同名游戏不会被误判为答案。

## 游戏数据

当前正式题库：

```text
public/games_demo.json
```

页面不会把整个 JSON 编译进主 JavaScript，而是在运行时通过 `fetch` 加载。这样可以让代码包和数据文件分别缓存，也便于未来替换数据来源。

数据抓取相关的 `scripts/`、`data/` 和 `Makefile` 是早期实验工具，目前可能互不兼容。本轮没有修复这条流水线；在重新确定 Steam 数据来源之前，不应把 `make pipeline` 视为可用命令。

## 测试

当前测试覆盖：

- 百分比距离计算
- 相同非零值的精确匹配
- 答案为零时的数值比较
- 日期比较和方向提示
- 使用 appId 判断胜负
- `allFieldsMatches` 字段完整性
- 搜索排序、结果限制和已猜排除
- 新一局避免重复上一题

测试文件位于：

```text
src/engine/__tests__/
src/data/__tests__/
```

## 安全说明

不要把 API token、Cookie 或其他凭据提交到仓库。项目根目录下的 `token` 已配置在 `.gitignore` 中，并应保持未跟踪状态。如果其中曾经保存过真实凭据，应在对应平台撤销并重新生成；仅从当前提交删除不能使历史凭据重新安全。

## 当前刻意不做的事情

为了先稳定核心玩法，当前没有加入：

- 每日挑战
- 登录、排行榜或多人模式
- 后端数据库
- 战绩和连胜统计
- 新的数据抓取方案
- 大规模题库搜索服务

这些应在确认产品方向后再决定，而不是继续堆在当前 MVP 上。
