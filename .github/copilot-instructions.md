# SteamGuess Development Instructions

## Project Overview

**SteamGuess** 是一个猜测 Steam 游戏的网页游戏。基于我们之前讨论的设计，用户通过搜索框输入游戏，系统将其与正确答案进行对比，用颜色编码的表格显示匹配度。

## Architecture Principles

本项目遵循这些核心原则：

### 1. Modularity (模块化)
- **ComparisonEngine**: 独立的对比逻辑类，可被任何组件调用
- **每个 compare* 方法**: 处理单一字段，逻辑清晰
- **易于扩展**: 添加新字段只需增加一个 `compare*` 方法

### 2. Low Coupling (低耦合)
- **Components 彼此独立**: SearchBox 和 GameTable 不直接通信
- **状态管理集中在 App.tsx**: 避免 prop drilling
- **配置与逻辑分离**: Threshold 在 `config/` 目录

### 3. Type Safety (类型安全)
- **完全 TypeScript 覆盖**: 所有数据结构都有类型定义
- **接口优先**: Game, ComparisonResult, FieldComparison 等
- **避免 any**: 用 Union Types 和 Generics

## 代码风格约定

### 函数风格
- 大括号不换行: `if (x) { ... }`
- 竞赛风格命名: 清晰简洁
- 注释: 对复杂逻辑和非显而易见的代码加注释

### 示例

```typescript
// ✅ 好 - 直接，清晰
private comparePrice(guess: PlayerGuess, correct: Game): FieldComparison {
  const userValue = guess.price ? `$${guess.price.current}` : null;
  const correctValue = `$${correct.price.current}`;
  
  let status: MatchStatus = 'unknown';
  if (!userValue) {
    status = 'unknown';
  } else {
    const diff = Math.abs(guess.price.current! - correct.price.current);
    status = diff <= this.config.priceThreshold ? 'exact' : 'wrong';
  }
  
  return { fieldName: 'Price', userValue, correctValue, status };
}

// ❌ 避免 - 过度设计
const getStatusForPrice = (userPrice?: number, correctPrice?: number, threshold?: number) => {
  // ... too much abstraction
}
```

## 工作流程

### 添加新的比较字段

1. **定义类型** (`src/types/game.ts`)
   - 在 `Game` interface 中添加新字段

2. **添加 Config**  (`src/config/comparison.ts`)
   - 如果需要 threshold，在这里定义

3. **实现对比方法** (`src/engine/ComparisonEngine.ts`)
   ```typescript
   private compareNewField(guess: PlayerGuess, correct: Game): FieldComparison {
     // ...
   }
   ```

4. **更新 compare 方法**
   ```typescript
   compare(guess: PlayerGuess, correctGame: Game): ComparisonResult {
     // ... 
     const newFieldMatch = this.compareNewField(guess, correctGame);
     result.allFieldsMatches.push(newFieldMatch);
   }
   ```

5. **添加 UI 显示** (`src/components/GameTable/GameTable.tsx`)
   - 在表格中添加新列

### 修改阈值

所有阈值都在 `src/config/comparison.ts`:

```typescript
export const comparisonConfig: ComparisonConfig = {
  priceThreshold: 10,              // 改这里调价格阈值
  popularityThresholdPercent: 50,  // 改这里调热度阈值
  // ...
};
```

**不要**在 ComparisonEngine 中硬编码阈值。

### 添加样本游戏数据

编辑 `src/data/games.ts`:

```typescript
export const sampleGames: Game[] = [
  {
    appId: 12345,
    name: "My Game",
    // ... 完整的 Game 对象
  },
];
```

## 常见任务

### 改颜色编码

1. 修改 `src/config/comparison.ts` 中的 `colorThreshold`
2. React 会自动重新渲染

### 改対比逻辑

比如，想让好评率匹配更宽松：

```typescript
// 在 compareReviews 方法中
const rateDiff = Math.abs(guess.reviews.positivePercent - correct.reviews.positivePercent);
if (rateDiff <= 10) {  // 改从 5 到 10
  status = 'exact';
}
```

### 测试新逻辑

1. 启动 `npm run dev`
2. 输入一个游戏，看表格反馈
3. 根据结果调整阈值

## 后续扩展点

### 1. 搜索优化 (Fuzzy Search)
- 当前: 简单的 `includes()` 匹配
- 未来: 加入拼音、同义词、纠错

### 2. 数据来源
- 当前: 硬编码 3 个样本游戏
- 未来: 批量导入 Steam 数据（爬虫或 API）

### 3. 多人模式
- 后端: Node.js + Socket.IO 房间管理
- 前端: 新增 Multiplayer.tsx 组件
- ComparisonEngine 可直接复用

### 4. 持久化
- 用户统计、排行榜存 MongoDB
- 游戏数据可以不存（用 Steam API）

## 文件快速导航

| 需要修改什么 | 看这个文件 |
|-------------|----------|
| 游戏数据结构 | `src/types/game.ts` |
| 对比逻辑 | `src/engine/ComparisonEngine.ts` |
| 颜色和阈值 | `src/config/comparison.ts` |
| UI 表格显示 | `src/components/GameTable/GameTable.tsx` |
| 样本数据 | `src/data/games.ts` |
| 主应用逻辑 | `src/App.tsx` |

## 调试技巧

### 查看对比结果

在 `App.tsx` 中添加：

```typescript
console.log('ComparisonResult:', comparisonResults[comparisonResults.length - 1]);
```

### 修改测试游戏

手动改 `sampleGames` 中的数据，重启 dev server。

### 单步跟踪对比逻辑

在 ComparisonEngine 方法中加 debugger:

```typescript
private comparePrice(guess: PlayerGuess, correct: Game): FieldComparison {
  debugger;  // 浏览器会在这里暂停
  // ...
}
```

## 开发流程总结

1. **修改代码** → 2. **Hot Reload**（Vite 自动）→ 3. **测试** → 4. **看表格反馈** → 5. **调整阈值或逻辑**

完全不需要重启。

---

**Remember**: 优先考虑清晰 > 聪明。未来的你和团队成员会感谢你。
