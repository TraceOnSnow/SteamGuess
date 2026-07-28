#!/usr/bin/env python3
"""Fit a tiny ordinal linear regression from manual SteamGuess labels.

No numpy/scikit-learn dependency is used. Labels are ordinal targets and ridge
regularization keeps a 50–100 label fit stable enough for a first iteration.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LEVEL_TARGET = {"easy": 0.0, "normal": 1.0, "hard": 2.0, "hell": 3.0}
FEATURES = ("owners", "ccu", "reviews", "playtime", "positiveRatio")


def solve(matrix: list[list[float]], vector: list[float]) -> list[float]:
    """Gaussian elimination with partial pivoting."""
    size = len(vector)
    augmented = [row[:] + [value] for row, value in zip(matrix, vector, strict=True)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            raise ValueError("Regression matrix is singular; add more varied labels")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        divisor = augmented[column][column]
        augmented[column] = [value / divisor for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            augmented[row] = [
                current - factor * pivot_value
                for current, pivot_value in zip(augmented[row], augmented[column], strict=True)
            ]
    return [augmented[row][-1] for row in range(size)]


def fit(rows: list[list[float]], targets: list[float], ridge: float) -> list[float]:
    width = len(rows[0])
    xtx = [[0.0] * width for _ in range(width)]
    xty = [0.0] * width
    for row, target in zip(rows, targets, strict=True):
        for i in range(width):
            xty[i] += row[i] * target
            for j in range(width):
                xtx[i][j] += row[i] * row[j]
    for i in range(1, width):  # do not regularize intercept
        xtx[i][i] += ridge
    return solve(xtx, xty)


def predict(coefficients: list[float], feature_values: dict[str, Any]) -> float:
    row = [1.0] + [float(feature_values.get(name, 0.0)) for name in FEATURES]
    return sum(coefficient * value for coefficient, value in zip(coefficients, row, strict=True))


def level_for_score(score: float) -> str:
    if score < 100 / 6:
        return "easy"
    if score < 50:
        return "normal"
    if score < 500 / 6:
        return "hard"
    return "hell"


def load_labels(path: Path) -> dict[int, dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    items = payload.get("labels", payload) if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        raise ValueError("Labels must be an array or an object containing a labels array")
    labels = {}
    for item in items:
        appid = int(item["appId"])
        level = item.get("level")
        excluded = bool(item.get("excluded", False))
        if not excluded and level not in LEVEL_TARGET:
            raise ValueError(f"Invalid difficulty label for appId {appid}: {level}")
        labels[appid] = {"level": level, "excluded": excluded}
    return labels


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", default="data/catalog/steamspy_top_2000.json")
    parser.add_argument("--labels", default="data/labels/difficulty_labels.json")
    parser.add_argument("--out", default="data/catalog/steamspy_top_2000_scored.json")
    parser.add_argument("--ridge", type=float, default=1.0)
    parser.add_argument("--min-labels", type=int, default=20)
    args = parser.parse_args()

    catalog = json.loads(Path(args.catalog).read_text(encoding="utf-8"))
    labels = load_labels(Path(args.labels))
    by_appid = {int(game["appId"]): game for game in catalog["games"]}

    rows, targets = [], []
    for appid, label in labels.items():
        if label["excluded"] or appid not in by_appid:
            continue
        rows.append([1.0] + [float(by_appid[appid]["recognition"]["features"].get(name, 0.0)) for name in FEATURES])
        targets.append(LEVEL_TARGET[label["level"]])

    if len(rows) < args.min_labels:
        raise ValueError(f"Need at least {args.min_labels} usable labels; found {len(rows)}")
    coefficients = fit(rows, targets, args.ridge)

    for game in catalog["games"]:
        appid = int(game["appId"])
        predicted = max(0.0, min(3.0, predict(coefficients, game["recognition"]["features"])))
        score = round(predicted / 3 * 100, 3)
        game["difficulty"].update({
            "score": score,
            "level": level_for_score(score),
            "source": "regression",
            "excluded": False,
            "manualLevel": None,
        })
        game["fieldSources"]["difficulty"] = "derived:ordinal-ridge-v1"
        if appid in labels:
            label = labels[appid]
            game["difficulty"].update({
                "excluded": label["excluded"],
                "manualLevel": label["level"],
                "source": "manual",
            })
            if label["level"]:
                game["difficulty"]["level"] = label["level"]
                game["difficulty"]["score"] = round(LEVEL_TARGET[label["level"]] / 3 * 100, 3)
            game["fieldSources"]["difficulty"] = "manual"

    catalog["generatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    catalog["model"] = {
        "name": "ordinal-ridge-linear-regression",
        "version": "ordinal-ridge-v1",
        "features": list(FEATURES),
        "coefficients": {"intercept": coefficients[0], **dict(zip(FEATURES, coefficients[1:], strict=True))},
        "ridge": args.ridge,
        "trainingLabels": len(rows),
    }
    catalog["stats"]["manualLabels"] = len(labels)
    catalog["stats"]["excluded"] = sum(game["difficulty"]["excluded"] for game in catalog["games"])

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"labels={len(rows)} coefficients={catalog['model']['coefficients']}")
    print(f"catalog={out}")


if __name__ == "__main__":
    main()
