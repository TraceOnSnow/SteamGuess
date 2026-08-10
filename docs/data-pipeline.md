# Catalog weekly update

## Safe first run

先用本地已有 catalog 做计划，不访问网络、不导入数据库：

```bash
npm run data:update-weekly -- \
  --from-existing-catalog \
  --plan-only \
  --catalog data/catalog/steamspy_top_2000.json \
  --active-limit 6000
```

正式周更入口：

```bash
npm run data:update-weekly
```

默认抓 SteamSpy page `0..19`，页间间隔 120 秒。运行时可以通过 `--pages` 和 `--interval` 调整，不建议在生产环境缩短间隔。

## 增量规则

- `active`：当前 catalog 前 `active-limit` 个 AppID，默认 6,000。
- `reserve`：其余候选，保留在 canonical SQLite 中但不做详细 enrichment。
- PICS、Storefront 和 Reviews 通过 `enrichment_jobs` 记录状态；已经完成的 AppID 不会重复进入队列。
- Storefront 只保留常态价格 `regular_cents`；当前折扣价和折扣比例不会进入 canonical 数据。
- Reviews 每个 AppID 保存英文、简体中文各最多 10 条 helpful snapshot。

## PICS 输入

当前 PICS 获取程序仍是外部/实验性流程。准备好 JSON 后传入：

```bash
npm run data:update-weekly -- --pics data/raw/pics/pics_2026-08-06.json
```

不传 `--pics` 时，不会静默清空已有 PICS 标签，而是继续保留上一版数据。

## 小规模测试

用临时目录和少量 AppID 测试，不要直接使用生产数据库：

```bash
python3 -m scripts.catalog.enrich_reviews \
  --catalog /tmp/steamguess-test/catalog.json \
  --appids /tmp/steamguess-test/appids.json \
  --out /tmp/steamguess-test/catalog.json \
  --limit 1
```

完成 JSON 流程后再执行：

```bash
npm run data:catalog-import -- \
  --db /tmp/steamguess-test/catalog.sqlite \
  --catalog /tmp/steamguess-test/catalog.json \
  --active-limit 1
```

最后检查：

```bash
npm run data:catalog-status -- --db /tmp/steamguess-test/catalog.sqlite
```

## Production weekly runner

生产环境不要直接用 `scripts/catalog/update_weekly.py` 定时执行。使用包装器：

```bash
npm run data:update-weekly-production
```

`scripts/ops/run_weekly_catalog.sh` 会：

1. 使用 `flock` 防止两个周更任务重叠；
2. 在 `/tmp` 中构建完整的新 catalog、JSON 和 SQLite；
3. 周更失败时不替换上一次成功的版本；
4. 发布前检查 AppID 唯一性、active/playable 一致性、标签数量和折扣价字段；
5. 替换前备份上一版 catalog 和 SQLite；
6. 保留最近 14 组 catalog 快照；
7. 将完整日志写入 `data/logs/`；
8. 如果设置 `STEAMGUESS_ALERT_WEBHOOK`，失败时发送 JSON 告警。

首次部署时，将 `deploy/systemd/steamguess-catalog-weekly.service` 和
`deploy/systemd/steamguess-catalog-weekly.timer` 复制到 `/etc/systemd/system/`，
并将 service 中的 `User`、`WorkingDirectory` 和路径改成服务器实际值：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now steamguess-catalog-weekly.timer
systemctl list-timers steamguess-catalog-weekly.timer
sudo systemctl start steamguess-catalog-weekly.service  # 首次手动验证
```

默认配置：

- SteamSpy 页间隔：120 秒；
- Storefront/Reviews 请求间隔：2 秒；
- active：前 6,000 个；
- PICS：如果没有传入 `STEAMGUESS_PICS_FILE`，保留旧数据并在 status 中显示 pending；
- 数据库和 JSON 的实际路径可通过 `STEAMGUESS_*_PATH` 环境变量覆盖。

## Weekly run recovery

The production wrapper uses a persistent staging directory at
`data/catalog/.weekly-work/current` (override with `STEAMGUESS_CATALOG_WORK_DIR`).
It is deliberately not stored under `/tmp`: if a process is killed or a machine
reboots, the staged catalog, SQLite copy, Storefront state, review progress, and
SteamSpy raw page checkpoints remain available. Re-running
`scripts/ops/run_weekly_catalog.sh` resumes that staged run. A successful atomic
publish removes the staging directory. Do not delete `current` while a failed
run is being resumed.

A Storefront transient failure now exits the enrichment stage after saving its
latest checkpoint, so the wrapper preserves the staged workspace instead of
publishing a partial release. Review enrichment behaves the same way by
default; pass `--allow-failures` only when intentionally publishing a partial
review snapshot.

SteamSpy 失败恢复参数：

- `STEAMGUESS_STEAMSPY_RETRIES=2`：单页每个 transport 的重试次数；
- `STEAMGUESS_STEAMSPY_RETRY_DELAY=30`：重试基础等待秒数，实际等待为 30、60 秒；
- 每页成功后立即写入 `raw-steamspy/page_<page>_*.json`，下次带 `--resume` 会跳过已完成页；
- 单页连续失败会保留 staging，不会发布不完整 catalog。冷却一段时间后直接重新运行正式入口即可。

正式入口等价于：

```bash
./scripts/ops/run_weekly_catalog.sh
```

### Field-aware enrichment

`enrichment_jobs` is only a resume hint, not the source of truth for the current
catalog snapshot. Before each weekly enrichment, the planner also checks the
active rows themselves. A Storefront job is queued again when the current row is
missing a Storefront type, simplified-Chinese name, or a CN price status. This
prevents a completed job from hiding fields lost during a later SteamSpy
rediscovery.
