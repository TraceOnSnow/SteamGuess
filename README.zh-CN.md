# SteamGuess - 开发者文档

## 项目简介

SteamGuess 是一个类似 Wordle 的游戏猜谜网页应用，玩家需要通过多次猜测来找出正确的 Steam 游戏。每次猜测后，系统会通过颜色编码的表格反馈提示信息（价格、人气、玩家模式、发行日期、标签等），帮助玩家逐步缩小范围。

**核心玩法：**
- 玩家有 10 次猜测机会
- 每次猜测会显示与正确答案的比对结果
- 通过颜色编码（绿色=完全匹配，黄色=部分匹配，橙色=接近，红色=错误）提供线索
- 猜对游戏名称即获胜

---

## 技术栈

### 前端框架与工具
- **React 19.2** - UI 组件库
- **TypeScript 5.9** - 类型安全的 JavaScript 超集
- **Vite 7.2** - 现代化前端构建工具
  - 快速的热模块替换（HMR）
  - 基于 ESM 的开发服务器
  - 优化的生产构建

### 开发工具
- **ESLint 9** - 代码质量检查
- **TypeScript ESLint** - TypeScript 专用 Lint 规则
- **@vitejs/plugin-react** - Vite 的 React 插件（支持 JSX/Fast Refresh）

### 样式方案
- 原生 CSS（`.css` 文件模块化管理）

---

## 项目架构

### 架构概述

```
用户交互层 (Components)
    ↓
应用状态管理层 (App.tsx)
    ↓
游戏逻辑层 (ComparisonEngine)
    ↓
数据层 (games.ts)
```

### 设计模式

1. **组件化架构** - 使用 React 函数式组件和 Hooks
2. **类型驱动开发** - 完整的 TypeScript 类型定义
3. **单向数据流** - React 状态管理模式
4. **关注点分离** - 逻辑、UI、数据明确分层

---

## 目录结构与文件说明

```
SteamGuess/
├── public/                          # 静态资源目录
│
├── src/                             # 源代码目录
│   ├── assets/                      # 图片、字体等资源
│   │
│   ├── components/                  # React 组件
│   │   ├── SearchBox/               # 搜索框组件
│   │   │   ├── SearchBox.tsx        # 游戏搜索与选择功能
│   │   │   └── SearchBox.css        # 搜索框样式
│   │   │
│   │   └── GameTable/               # 游戏比对表格组件
│   │       ├── GameTable.tsx        # 显示猜测历史和结果
│   │       └── GameTable.css        # 表格样式
│   │
│   ├── config/                      # 配置文件
│   │   └── comparison.ts            # 比对算法配置（阈值、颜色等）
│   │
│   ├── data/                        # 数据层
│   │   └── games.ts                 # 游戏数据库和搜索功能
│   │
│   ├── engine/                      # 核心逻辑引擎
│   │   └── ComparisonEngine.ts      # 游戏比对算法实现
│   │
│   ├── types/                       # TypeScript 类型定义
│   │   ├── game.ts                  # 游戏数据类型
│   │   └── comparison.ts            # 比对结果类型
│   │
│   ├── App.tsx                      # 根组件（状态与流程管理）
│   ├── App.css                      # 根组件样式
│   ├── main.tsx                     # 应用入口文件
│   └── index.css                    # 全局样式
│
├── index.html                       # HTML 入口文件
├── vite.config.ts                   # Vite 构建配置
├── tsconfig.json                    # TypeScript 主配置
├── tsconfig.app.json                # 应用代码 TS 配置
├── tsconfig.node.json               # Node 环境 TS 配置
├── eslint.config.js                 # ESLint 代码规范配置
├── package.json                     # 项目依赖和脚本
└── README.md                        # 项目说明文档
```

---

## 核心模块详解

### 1. 类型系统 (`src/types/`)

#### `game.ts` - 游戏数据结构
定义了完整的游戏信息类型：

```typescript
interface Game {
  appId: number;              // Steam App ID
  name: string;               // 游戏名称
  releaseDate: string;        // 发行日期 (YYYY-MM-DD)
  price: GamePrice;           // 价格信息
  popularity: GamePopularity; // 人气数据
  reviews: GameReviews;       // 评价信息
  players: GamePlayers;       // 玩家模式
  tags: GameTags;             // 标签和类型
  hints?: GameHints;          // 可选提示信息
}
```

**子类型包括：**
- `GamePrice` - 当前价格和历史最低价
- `GamePopularity` - 当前周活跃玩家数和历史峰值
- `GameReviews` - 评价数量、好评率、Steam评级
- `GamePlayers` - 是否支持单人/多人/在线模式
- `GameTags` - 用户标签、类型、开发商、发行商



#### `comparison.ts` - 比对结果类型
定义了比对算法的输出结构：

```typescript
type MatchStatus = 'exact' | 'partial' | 'close' | 'wrong' | 'unknown';

interface ComparisonResult {
  nameMatch: FieldComparison;       // 名称匹配
  playerMatch: FieldComparison;     // 玩家模式匹配
  priceMatch: FieldComparison;      // 价格匹配
  popularityMatch: FieldComparison; // 人气匹配
  reviewsRateMatch: FieldComparison;    // 评价匹配
  releaseMatch: FieldComparison;    // 发行日期匹配
  tagsMatch: FieldComparison;       // 标签匹配
  allFieldsMatches: FieldComparison[];
  isCorrect: boolean;               // 是否完全正确
}
```

---

### 2. 比对引擎 (`src/engine/ComparisonEngine.ts`)

**职责：** 实现游戏属性的模糊匹配算法

**核心方法：**

```typescript
class ComparisonEngine {
  compare(guess: PlayerGuess, correctGame: Game): ComparisonResult
}
```

**匹配算法示例：**

1. **价格比对** (`comparePrice`)
   - 完全匹配：当前价和历史低价均在阈值内（±$10）
   - 部分匹配：至少一个价格在阈值内
   - 接近：当前价格在 2 倍阈值内
   - 错误：超出上述范围

2. **人气比对** (`comparePopularity`)
   - 基于百分比差异判断（20% 阈值）
   - 同时考虑当前周活跃和历史峰值

3. **标签比对** (`compareTags`)
   - 计算标签集合交集占比
   - 75%+ 重叠 = 完全匹配
   - 部分重叠 = 部分匹配

4. **发行日期比对** (`compareRelease`)
   - 完全匹配：同年
   - 接近：±2 年内
   - 提供箭头提示（↑ 更早 / ↓ 更晚）

**配置化设计：** 所有阈值定义在 `config/comparison.ts`，便于调整难度

---

### 3. 数据层 (`src/data/games.ts`)

**功能：**
- 存储游戏数据库（`sampleGames` 数组）
- 提供搜索功能（`searchGames`）
- 提供按 ID 查询（`getGameById`）

**搜索实现：**
```typescript
export function searchGames(query: string): Game[] {
  const lowerQuery = query.toLowerCase();
  return sampleGames.filter(game =>
    game.name.toLowerCase().includes(lowerQuery)
  );
}
```

**扩展性：** 当前使用内存数组，未来可替换为 API 调用或索引数据库

---

### 4. 组件层 (`src/components/`)

#### `SearchBox.tsx` - 搜索与选择
- 输入框实时搜索
- 下拉列表显示匹配结果
- 选择游戏后触发回调
- 游戏结束时禁用输入

**关键实现：**
```typescript
const results = useMemo(() => {
  if (!query.trim()) return [];
  return searchGames(query);
}, [query]);
```
使用 `useMemo` 优化性能，避免重复搜索

#### `GameTable.tsx` - 结果展示
- 表格展示所有猜测历史
- 根据 `MatchStatus` 应用背景色
- 显示箭头等提示符号
- 游戏结束后显示正确答案

**颜色映射：**
```typescript
getStatusColor(status: MatchStatus): string
// exact   → 绿色 (#4CAF50)
// partial → 黄色 (#FFC107)
// close   → 橙色 (#FF9800)
// wrong   → 红色 (#F44336)
```

---

### 5. 应用主控 (`src/App.tsx`)

**职责：** 状态管理和游戏流程控制

**状态管理：**
```typescript
const [currentGame, setCurrentGame] = useState<Game | null>(null);
const [guesses, setGuesses] = useState<Game[]>([]);
const [comparisonResults, setComparisonResults] = useState<ComparisonResult[]>([]);
const [gameOver, setGameOver] = useState(false);
const [attemptsLeft, setAttemptsLeft] = useState(10);
```

**核心流程：**
1. 玩家选择游戏 → `handleSelectGame`
2. 调用 `ComparisonEngine.compare` 获取比对结果
3. 更新状态（猜测历史、剩余次数）
4. 检查胜利/失败条件
5. 游戏结束后可重新开始 → `handleNewGame`

---

## 配置文件说明

### `vite.config.ts`
```typescript
export default defineConfig({
  plugins: [react()],
})
```
- 配置 React 插件以支持 JSX 和 Fast Refresh

### `tsconfig.json` 系列
- `tsconfig.json` - 主配置，引用子配置
- `tsconfig.app.json` - 应用代码配置（`src/`）
- `tsconfig.node.json` - 构建脚本配置（Vite 配置文件等）

### `eslint.config.js`
- 使用 Flat Config 格式（ESLint 9 新特性）
- 集成 TypeScript、React Hooks、React Refresh 规则

---

## 开发指南

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器（默认 http://localhost:5173）
npm run dev

# 代码检查
npm run lint

# 构建生产版本
npm run build

# 预览生产构建
npm run preview
```

### 添加新游戏

编辑 `src/data/games.ts`，在 `sampleGames` 数组中添加：

```typescript
{
  appId: 123456,
  name: '游戏名称',
  releaseDate: '2024-01-01',
  price: {
    current: 29.99,
    historicalLow: 19.99,
  },
  // ... 其他字段
}
```

### 调整比对难度

修改 `src/config/comparison.ts` 中的阈值：

```typescript
export const comparisonConfig: ComparisonConfig = {
  priceThreshold: 10,           // 价格阈值（美元）
  popularityThresholdPercent: 20, // 人气阈值（百分比）
  ratingThresholdPercent: 5,    // 评分阈值（百分比）
  yearThreshold: 0,             // 发行年份阈值
  tagOverlapPercent: 75,        // 标签重叠阈值（百分比）
};
```

### 修改颜色主题

同样在 `src/config/comparison.ts` 中修改 `colorThreshold`：

```typescript
export const colorThreshold: ColorThreshold = {
  exact: '#4CAF50',   // 完全匹配 - 绿色
  partial: '#FFC107', // 部分匹配 - 黄色
  close: '#FF9800',   // 接近 - 橙色
  wrong: '#F44336',   // 错误 - 红色
  unknown: '#9E9E9E', // 未知 - 灰色
};
```

---

## 技术亮点

### 1. 类型安全
- 完整的 TypeScript 类型覆盖
- 避免运行时类型错误
- 增强代码可维护性

### 2. 性能优化
- `useMemo` 缓存搜索结果
- Vite 提供快速热更新
- 生产构建自动 Tree Shaking 和代码分割

### 3. 组件复用性
- `SearchBox` 和 `GameTable` 完全解耦
- 通过 Props 接口通信
- 易于在其他项目中复用

### 4. 可配置性
- 比对算法参数集中管理
- 颜色主题独立配置
- 游戏数据与逻辑分离

### 5. 可扩展性
- 易于添加新的比对维度（如开发商、DLC 数量等）
- 可替换数据源（API、数据库）
- 可集成用户系统和排行榜

---

## 未来改进方向

1. **数据源**
   - 集成 Steam API 获取实时数据
   - 支持更大的游戏库

2. **功能增强**
   - 添加提示系统
   - 支持多种难度模式
   - 添加每日挑战模式

3. **用户体验**
   - 添加动画效果
   - 响应式设计优化
   - 暗黑模式支持

4. **社交功能**
   - 分享结果到社交媒体
   - 添加排行榜
   - 好友对战模式

5. **性能**
   - 使用虚拟滚动处理大量游戏数据
   - 实现服务端渲染（SSR）

---

## 常见问题

### Q: 为什么使用 Vite 而不是 Create React App？
**A:** Vite 提供更快的冷启动和热更新速度，使用原生 ESM，构建产物也更小。CRA 已经逐渐被社区淘汰。

### Q: 如何部署到生产环境？
**A:** 
```bash
npm run build
# 将 dist/ 目录部署到任何静态托管服务
# 如 Vercel、Netlify、GitHub Pages 等
```

### Q: 可以改成其他主题（如电影、音乐）吗？
**A:** 完全可以！只需：
1. 修改 `types/game.ts` 定义新的数据类型
2. 更新 `data/games.ts` 提供新数据
3. 调整 `ComparisonEngine.ts` 的比对逻辑
4. 更新 UI 文案和样式

### Q: 如何调试比对算法？
**A:** 在 `ComparisonEngine.ts` 的 `compare` 方法中添加 `console.log` 输出中间结果：
```typescript
compare(guess: PlayerGuess, correctGame: Game): ComparisonResult {
  const result = ...;
  console.log('Comparison result:', result);
  return result;
}
```

---

## 相关资源

- [React 官方文档](https://react.dev/)
- [TypeScript 手册](https://www.typescriptlang.org/docs/)
- [Vite 指南](https://vitejs.dev/guide/)
- [Steam Web API](https://steamcommunity.com/dev)

---

## 许可证

MIT

---

**最后更新：** 2026-02-22

**项目状态：** 功能完整，可用于学习和演示
