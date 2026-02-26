#!/usr/bin/env bash
set -euo pipefail

# 先预览：把 echo mv 改成 mv 就会真正执行
for f in page*_*.json; do
  [[ -e "$f" ]] || continue
  # 提取第一个下划线前缀，例如 page0_20260225_224527.json -> page0
  base="${f%%_*}"
  new="${base}.json"
  mv -v -- "$f" "$new"
done