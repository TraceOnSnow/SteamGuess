# SteamGuess 项目概览（中文）

## 🎮 项目简介

**SteamGuess** 是一个猜测 Steam 游戏的网页游戏。游戏流程很简单：
- 系统随机选择一款 Steam 游戏作为答案
- 玩家通过搜索框输入游戏名称进行猜测
- 每次猜测后，系统通过**颜色编码表格**显示猜测的游戏与正确答案的匹配程度
- 玩家有 10 次机会猜对答案

这是一个 **MVP（最小可行产品）** 实现，只有单人游戏模式，暂不支持多人对战。

---

## 🏗️ 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| React | 18 | 前端框架 |
| TypeScript | 5.x | 类型安全 |
| Vite | 7.3 | 构建工具与开发服务器 |
| CSS3 | - | 样式 |

**项目特点**：
- ✅ 100% TypeScript 覆盖（类型安全）
- ✅ 零外部依赖（除了 React 和开发工具）
- ✅ 模块化架构（易于扩展）
- ✅ HMR（Hot Module Reload）支持，修改代码即时刷新

---

## 📁 项目结构

```
SteamGuess/
├── src/
│   ├── types/                    # TypeScript 类型定义
│   │   ├── game.ts              # 游戏数据结构
│   │   └── comparison.ts        # 对比结果结构
│   │
│   ├── config/                   # 配置文件
│   │   └── comparison.ts        # 对比阈值 & 颜色映射
│   │
│   ├── engine/                   # 核心业务逻辑
│   │   └── ComparisonEngine.ts  # 游戏对比引擎
│   │
│   ├── data/                     # 数据与工具函数
│   │   └── games.ts             # 样本游戏数据 & 查询函数
│   │
│   ├── components/               # React 组件
│   │   ├── SearchBox/           # 搜索输入框
│   │   │   ├── SearchBox.tsx
│   │   │   └── SearchBox.css
│   │   │
│   │   └── GameTable/           # 对比结果表格
│   │       ├── GameTable.tsx
│   │       └── GameTable.css
│   │
│   ├── App.tsx                  # 主应用组件（状态管理）
│   ├── App.css                  # 全局样式
│   ├── main.jsx                 # 入口文件
│   └── index.css                # 基础样式
│
├── package.json                  # NPM 依赖声明
├── vite.config.js               # Vite 配置
├── tsconfig.json                # TypeScript 配置
└── README.md                     # 项目说明
```

---

## 🔑 核心概念

### 1. **Game 接口** (`src/types/game.ts`)

代表一款 Steam 游戏的完整信息：

```typescript
interface Game {
  appId: number;                    // Steam App ID
  name: string;                     // 游戏名称
  releaseDate: string;              // 发布日期 (YYYY-MM-DD)
  price: GamePrice;                 // 价格信息
  popularity: GamePopularity;       // 热度信息（周/峰值并发）
  reviews: GameReviews;             // 评论信息（数量/正面率/评分）
  players: GamePlayers;             // 游戏模式（单人/多人/在线）
  tags: GameTags;                   // 标签（用户标签/类型/开发商/发行商）
  hints?: GameHints;                // 可选：提示信息
}
```

### 2. **ComparisonResult 接口** (`src/types/comparison.ts`)

代表一次对比的完整结果，包含 7 个字段的对比结果：

```typescript
interface ComparisonResult {
  nameMatch: FieldComparison;       // 游戏名称匹配度
  playerMatch: FieldComparison;     // 游戏模式匹配度
  priceMatch: FieldComparison;      // 价格匹配度
  popularityMatch: FieldComparison; // 热度匹配度
  reviewsMatch: FieldComparison;    // 评论匹配度
  releaseMatch: FieldComparison;    // 发布日期匹配度
  tagsMatch: FieldComparison;       // 标签匹配度
  isCorrect: boolean;               // 是否完全正确
}
```

每个 `FieldComparison` 包含：
- `status`: 'exact'(绿) | 'partial'(黄) | 'close'(橙) | 'wrong'(红) | 'unknown'(灰)
- `userValue` & `correctValue`: 用户输入的值与正确答案
- `display`: 可选的显示信息（如 "↑" 表示用户的值偏高）

### 3. **ComparisonEngine** (`src/engine/ComparisonEngine.ts`)

核心对比逻辑，有 7 个 `compare*()` 方法，每个处理一个字段：

| 字段 | 对比逻辑 |
|------|--------|
| **Name** | 完全匹配 = exact，否则 wrong |
| **Players** | 游戏模式交集（如都有单人+在线）|
| **Price** | ±$10 = exact, ±$20 = partial, ±$40 = close |
| **Popularity** | ±20% 周并发 = exact, ±50% = partial, ±100% = close |
| **Reviews** | ±5% 正面率 = exact, ±15% = partial, ±30% = close |
| **Release** | 同年 = exact, ±1年 = partial, ±3年 = close |
| **Tags** | 用户标签/类型/开发商/发行商的重合度 |

所有阈值都定义在 `src/config/comparison.ts` 中，可随时调整。

---

## 💾 数据流

```
用户在 SearchBox 输入游戏名
        ↓
searchGames() 返回匹配的游戏列表
        ↓
用户点击选择一个游戏
        ↓
App.tsx 中的 handleSelectGame() 被触发
        ↓
ComparisonEngine.compare(guessedGame, correctGame)
        ↓
返回 ComparisonResult（7个字段的对比结果）
        ↓
GameTable 根据 status 应用颜色，显示结果
```

---

## 🎨 颜色编码

| 颜色 | 含义 | 状态 |
|------|------|------|
| 🟢 绿色 (#4CAF50) | **Exact** - 完全或很接近 | 很可能正确 |
| 🟡 黄色 (#FFC107) | **Partial** - 部分匹配 | 朝对的方向 |
| 🟠 橙色 (#FF9800) | **Close** - 接近但不够近 | 还有差距 |
| 🔴 红色 (#F44336) | **Wrong** - 完全错误 | 反方向 |
| ⚫ 灰色 (#9E9E9E) | **Unknown** - 无法判断 | 数据不足 |

---

## 📊 当前状态

### ✅ 已实现

- [x] 单人游戏模式
- [x] 搜索功能（根据游戏名/标签/开发商）
- [x] 7 字段对比引擎
- [x] 颜色编码表格显示
- [x] 10 次尝试限制
- [x] 赢/输判定逻辑
- [x] 样本数据（3 款游戏：Elden Ring, Dota 2, Spore）
- [x] 完整的 TypeScript 类型覆盖
- [x] 模块化架构

### ⏳ 未实现（后续扩展）

- [ ] 模糊搜索（拼音、同义词）
- [ ] 更多样本游戏（爬虫 or Steam API）
- [ ] 多人模式（WebSocket + Backend）
- [ ] 游戏统计与排行榜（数据库）
- [ ] 移动端适配优化
- [ ] 深色模式

---

## 🔧 核心文件详解

### `src/types/game.ts`

定义了游戏所有可能的数据结构。**新增游戏字段时必须先在这里定义类型**。

```typescript
export interface GameTags {
  userTags: string[];      // 玩家给的标签（如 "Action", "RPG"）
  genres: string[];        // 游戏类型
  developer: string;       // 开发商
  publisher: string;       // 发行商
}
```

### `src/engine/ComparisonEngine.ts`

199 行的核心逻辑。所有对比方法都返回 `FieldComparison`。

**关键方法**：
- `compare(guess, correctGame)` - 主入口，调用所有 compare* 方法
- `compareName()` - 名称完全匹配
- `comparePlayers()` - 游戏模式交集
- `comparePrice()` - 价格偏差计算
- `comparePopularity()` - 并发人数偏差
- `compareReviews()` - 正面率偏差
- `compareRelease()` - 发布年份差
- `compareTags()` - 标签重合度（集合交集）

### `src/config/comparison.ts`

所有配置都在这里，修改阈值只需改这个文件：

```typescript
export const comparisonConfig: ComparisonConfig = {
  priceThreshold: 10,              // ±$10 算 exact
  popularityThresholdPercent: 20,  // ±20% 算 exact
  // ...
};
```

### `src/data/games.ts`

样本数据和查询函数。**新增游戏数据只需改这里**。

```typescript
export const sampleGames: Game[] = [
  { appId: 1245620, name: 'Elden Ring', ... },
  { appId: 570, name: 'Dota 2', ... },
  { appId: 8980, name: 'Spore', ... }
];

// 模糊搜索
export function searchGames(query: string): Game[] {
  // 搜索名称、标签、开发商、发行商
}
```

### `src/components/SearchBox/SearchBox.tsx`

搜索输入框和下拉列表。`useMemo` 缓存搜索结果避免重复计算。

```typescript
export const SearchBox: React.FC<SearchBoxProps> = ({ onSelectGame, isDisabled }) => {
  const results = useMemo(() => {
    if (!query.trim()) return [];
    return searchGames(query);  // 每次输入都搜索
  }, [query]);
```

### `src/components/GameTable/GameTable.tsx`

显示对比结果的 7 列表格。每格背景色由 `status` 决定。

```typescript
<td style={{ backgroundColor: getStatusColor(result.nameMatch.status) }}>
  {guess.name}
</td>
```

### `src/App.tsx`

整个应用的状态容器（State Management）：

```typescript
const [currentGame, setCurrentGame] = useState<Game | null>(sampleGames[0]);
const [guesses, setGuesses] = useState<Game[]>([]);
const [comparisonResults, setComparisonResults] = useState<ComparisonResult[]>([]);
const [gameOver, setGameOver] = useState(false);
const [attemptsLeft, setAttemptsLeft] = useState(10);
```

每次 `handleSelectGame()` 时：
1. 调用 `comparisonEngine.compare()`
2. 更新 `guesses` 和 `comparisonResults`
3. 检查胜利条件（name exact match）
4. 检查失败条件（attempts = 0）

---

## 🚀 如何运行

```bash
# 安装依赖
npm install

# 启动开发服务器（HMR enabled）
npm run dev

# 打开浏览器
# http://localhost:5173 (or 5174 if 5173 busy)

# 构建生产版本
npm run build

# 预览构建结果
npm run preview
```

---

## 🎯 如何修改

### 改颜色映射

编辑 `src/config/comparison.ts`：

```typescript
export const colorThreshold: ColorThreshold = {
  exact: '#4CAF50',    // 改这里，比如 '#00FF00'（纯绿）
  partial: '#FFC107',
  // ...
};
```

Vite HMR 会自动刷新，无需重启服务器。

### 改对比阈值

编辑 `src/config/comparison.ts`：

```typescript
export const comparisonConfig: ComparisonConfig = {
  priceThreshold: 10,  // 改从 10 到 5，±$5 就算 exact
  // ...
};
```

然后在页面上重新猜测，看看效果。

### 增加新的游戏数据

编辑 `src/data/games.ts`，添加到 `sampleGames` 数组：

```typescript
{
  appId: 12345,
  name: 'My Game',
  releaseDate: '2025-06-15',
  price: { current: 39.99, historicalLow: 19.99 },
  // ... 其他字段
}
```

确保字段完整并符合 `Game` 接口。

### 增加新的对比字段

1. **定义类型** - 在 `src/types/game.ts` 的 `Game` 接口中添加
2. **添加阈值** - 在 `src/config/comparison.ts` 中添加配置
3. **实现对比方法** - 在 `src/engine/ComparisonEngine.ts` 中添加 `compareNewField()` 方法
4. **更新 compare()** - 在 `compare()` 方法中调用新方法
5. **更新 UI** - 在 `src/components/GameTable/GameTable.tsx` 中添加新列

---

## 🔍 调试技巧

### 查看对比结果

在浏览器 Console 中运行：

```javascript
// App.tsx 中已经有 console.log，可以在猜测后看到完整 ComparisonResult
// 或者打开 DevTools 看 React 组件树
```

### 修改测试游戏

直接改 `src/data/games.ts` 中的样本数据，保存后会自动刷新。

### 单步跟踪对比逻辑

在 `src/engine/ComparisonEngine.ts` 的任意 `compare*()` 方法中加：

```typescript
debugger;  // 浏览器会在这里暂停，可以逐步执行
```

然后在 DevTools 的 Sources 标签页可以看到执行步骤。

---

## 📝 架构设计原则

这个项目遵循三个核心原则：

### 1️⃣ 模块化（Modularity）

- **ComparisonEngine** 独立，可被任何组件调用
- 每个 `compare*` 方法处理单一字段
- 新增字段不影响现有代码

### 2️⃣ 低耦合（Low Coupling）

- **SearchBox** 和 **GameTable** 完全独立，通过 props 通信
- 状态管理集中在 **App.tsx**
- 配置与逻辑分离

### 3️⃣ 类型安全（Type Safety）

- 100% TypeScript 覆盖
- 所有数据结构都有接口定义
- 避免使用 `any`

---

## 🤔 为什么这样设计？

### 为什么用 ComparisonEngine 类而不是函数？

答：方便后续扩展。比如，未来想加 "难度等级"（如只对比价格），可以直接在构造函数中传参。

### 为什么 Game.releaseDate 是 string 而不是 Date？

答：Date 对象在 JSON 序列化时容易出问题。字符串格式 `YYYY-MM-DD` 更稳定，也便于数据库存储。

### 为什么所有阈值都在 config 文件中？

答：游戏平衡性很重要。改一个数字就能调整游戏难度，无需改业务逻辑。

---

## 📚 后续学习建议

1. **玩一遍游戏** - 理解游戏流程和颜色逻辑
2. **追踪一次对比** - 在 ComparisonEngine 中加 console.log，看看内部计算
3. **改一个阈值** - 比如把 priceThreshold 从 10 改成 5，看看表格变化
4. **增加一个游戏** - 在 games.ts 中添加一款新游戏（记住所有字段！）
5. **修改搜索逻辑** - 在 searchGames() 中添加更聪明的匹配（如拼音搜索）

---

## 💭 最后的话

这个 MVP 虽然代码行数不多（~200 行核心逻辑），但设计思路很清晰。**优先考虑清晰 > 聪明**。

每一个文件都有明确的责任：
- **types/** - 数据定义
- **config/** - 游戏参数
- **engine/** - 核心逻辑
- **data/** - 数据与工具
- **components/** - UI 展示

未来你会发现，当需要添加新功能时，通常只需改其中一个目录的文件，而其他地方完全不受影响。这就是好的架构的力量。

祝你玩得开心！🎮
