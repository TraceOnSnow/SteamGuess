SHELL := /bin/bash

PYTHON ?= python3
DATE ?= $(shell date +%Y%m%d_%H%M%S)

TOP_N ?= 100
SPY_LIST ?= top100in2weeks
STORE_CC ?= us
STORE_INTERVAL ?= 2.5
SPY_INTERVAL ?= 15
SPY_ALL_INTERVAL ?= 60
MAX_RETRIES ?= 1
TIMEOUT ?= 25

TOPLIST_SOURCE_FILE ?= data/raw/toplists/top1000_20260224.json
TOPLIST_RAW_OUT ?= data/raw/toplists/toplist_raw_$(DATE).json
APPIDS_OUT ?= data/processed/toplist_appids.json

RAW_OUT ?= data/raw/games/games_raw_$(DATE).jsonl
PROCESSED_OUT ?= data/processed/games_$(DATE).json
TARGET_PUBLIC ?= public/games.json

APPIDS_IN ?= $(APPIDS_OUT)
RAW_IN ?= $(RAW_OUT)
PROCESSED_IN ?= $(PROCESSED_OUT)

.PHONY: help dirs toplist-api toplist-file fetch convert publish pipeline convert-latest publish-latest organize check-python

help:
	@echo "Targets:"
	@echo "  make toplist-api    - 从 SteamSpy API 生成 appid 列表"
	@echo "  make toplist-file   - 从本地 toplist JSON 生成 appid 列表"
	@echo "  make fetch          - 抓取 raw JSONL 到 data/raw/games"
	@echo "  make convert        - 把 RAW_IN 转成 PROCESSED_OUT"
	@echo "  make publish        - 把 PROCESSED_IN 发布到 public/games.json"
	@echo "  make pipeline       - 一键 toplist-file + fetch + convert + publish"
	@echo "  make convert-latest - 转换最新的 raw JSONL"
	@echo "  make publish-latest - 发布最新的 processed JSON"
	@echo "  make organize       - 创建标准数据目录"
	@echo ""
	@echo "Common overrides:"
	@echo "  TOP_N=1000 SPY_LIST=top100in2weeks STORE_CC=us"
	@echo "  STORE_INTERVAL=2.5 SPY_INTERVAL=1 SPY_ALL_INTERVAL=60"
	@echo "  TOPLIST_SOURCE_FILE=... APPIDS_OUT=..."
	@echo "  RAW_OUT=... PROCESSED_OUT=... TARGET_PUBLIC=..."

dirs:
	@mkdir -p data/raw/toplists data/raw/games data/processed logs

organize: dirs
	@echo "Directory layout is ready."

check-python:
	@command -v $(PYTHON) >/dev/null || (echo "Python not found: $(PYTHON)" && exit 1)

toplist-api: dirs check-python
	@echo "[toplist-api] $(SPY_LIST) -> $(APPIDS_OUT)"
	$(PYTHON) scripts/fetch_toplist.py \
		--mode api \
		--request $(SPY_LIST) \
		--raw-out $(TOPLIST_RAW_OUT) \
		--top-n $(TOP_N) \
		--timeout $(TIMEOUT) \
		--out $(APPIDS_OUT)

toplist-file: dirs check-python
	@test -f "$(TOPLIST_SOURCE_FILE)" || (echo "TOPLIST_SOURCE_FILE not found: $(TOPLIST_SOURCE_FILE)" && exit 1)
	@echo "[toplist-file] $(TOPLIST_SOURCE_FILE) -> $(APPIDS_OUT)"
	$(PYTHON) scripts/fetch_toplist.py \
		--mode file \
		--source-file $(TOPLIST_SOURCE_FILE) \
		--top-n $(TOP_N) \
		--out $(APPIDS_OUT)

fetch: dirs check-python
	@test -f "$(APPIDS_IN)" || (echo "APPIDS_IN not found: $(APPIDS_IN). Run make toplist-file or make toplist-api first." && exit 1)
	@echo "[fetch] -> $(RAW_OUT)"
	$(PYTHON) scripts/fetch_games.py \
		--appid-list $(APPIDS_IN) \
		--top-n $(TOP_N) \
		--store-cc $(STORE_CC) \
		--store-interval $(STORE_INTERVAL) \
		--spy-interval $(SPY_INTERVAL) \
		--spy-all-interval $(SPY_ALL_INTERVAL) \
		--max-retries $(MAX_RETRIES) \
		--timeout $(TIMEOUT) \
		--out $(RAW_OUT) \
		--resume $(RESUME)

convert: dirs check-python
	@test -f "$(RAW_IN)" || (echo "RAW_IN not found: $(RAW_IN)" && exit 1)
	@echo "[convert] $(RAW_IN) -> $(PROCESSED_OUT)"
	$(PYTHON) scripts/convert_raw_jsonl.py --in $(RAW_IN) --out $(PROCESSED_OUT)

publish: dirs
	@test -f "$(PROCESSED_IN)" || (echo "PROCESSED_IN not found: $(PROCESSED_IN)" && exit 1)
	@echo "[publish] $(PROCESSED_IN) -> $(TARGET_PUBLIC)"
	@cp "$(PROCESSED_IN)" "$(TARGET_PUBLIC)"

pipeline: toplist-file fetch convert publish
	@echo "Pipeline done: $(TARGET_PUBLIC)"

convert-latest: dirs check-python
	@LATEST_RAW=$$(ls -1t data/raw/games/games_raw_*.jsonl 2>/dev/null | head -n 1); \
	if [[ -z "$$LATEST_RAW" ]]; then echo "No raw files found in data/raw/games"; exit 1; fi; \
	echo "[convert-latest] $$LATEST_RAW -> $(PROCESSED_OUT)"; \
	$(PYTHON) scripts/convert_raw_jsonl.py --in "$$LATEST_RAW" --out "$(PROCESSED_OUT)"

publish-latest: dirs
	@LATEST_PROCESSED=$$(ls -1t data/processed/games_*.json 2>/dev/null | head -n 1); \
	if [[ -z "$$LATEST_PROCESSED" ]]; then echo "No processed files found in data/processed"; exit 1; fi; \
	echo "[publish-latest] $$LATEST_PROCESSED -> $(TARGET_PUBLIC)"; \
	cp "$$LATEST_PROCESSED" "$(TARGET_PUBLIC)"
