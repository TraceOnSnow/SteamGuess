# SteamGuess 首轮 AI 难度评估规则 v1

## 目标玩家

以熟悉 Steam 和 PC 游戏、了解主流游戏文化的中文玩家为基准。评估的是“从截图、评论、标签、厂商、日期等线索认出具体游戏有多难”，不是游戏通关难度。

## 统一分数

- 0–24：简单。大众知名、系列和视觉辨识度很高。
- 25–49：普通。核心玩家多半听过，但可能与同系列或同类型混淆。
- 50–74：困难。较小众、老旧、区域性明显，或线索容易与别的作品混淆。
- 75–100：地狱。极小众、几乎无文化辨识度，或即使看线索也很难定位到具体作品。

分数越高越难。不要为了凑数量强制均匀分布。

## 准入判断优先于难度

每项先判断 `eligible`。以下通常排除：

- 壁纸、加速器、绘图/建模/剪辑软件
- Benchmark、SDK、编辑器、Dedicated Server、驱动或工具
- Soundtrack、Artbook、影片、纯 DLC、试玩 Demo
- 重复商店条目、无法形成合理猜题体验的测试内容

不能仅依据 Steam 的 `appType`；Steam 可能把软件标成 `game`。

`exclusionReason` 使用：`software`、`tool`、`benchmark`、`server`、`demo`、`soundtrack`、`dlc`、`duplicate`、`test-content`、`not-a-reasonable-guess` 或 `null`。

## 评分依据

综合考虑：

1. 中文 PC 玩家中的知名度，而非只看全球销量。
2. 系列、角色、画面、玩法和 UI 的辨识度。
3. 是否容易与同系列前作、续作或同类游戏混淆。
4. 发行年代、当前文化影响力和是否仍活跃。
5. 标签、厂商、截图和评论作为线索时能否指向具体作品。

热度数据只是辅助。不要把销量、在线人数机械换算成难度。

## 旧数据的使用方式

输入中的 `legacy` 只用于发现冲突，绝不视为真值：

- `manualScore` 可能混入旧的 1–4 等级、排名或错误分数。
- `curated.basis = Heuristic fill` 不是人工标注。
- 不参考任何历史自动难度结果，只依据本次输入资料和评分标准判断。

## 输出要求

对每款游戏输出：

```json
{
  "appId": 123,
  "eligible": true,
  "exclusionReason": null,
  "score": 18,
  "level": "easy",
  "confidence": 0.86,
  "reason": "不超过 40 个中文字符的简短理由",
  "reviewPriority": "normal"
}
```

- `score` 必须是 0–100 整数；排除项也可给出假设作为游戏时的分数，但不会发布。
- `level` 必须严格由分数区间计算。
- `confidence` 为 0–1。
- `reviewPriority`：`high`（疑似软件/资料冲突/边界难判）、`normal`、`low`（判断稳定）。
- 不要更改输入文件，不要写数据库或正式 catalog。
