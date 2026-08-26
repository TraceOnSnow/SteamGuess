#!/usr/bin/env python3
"""Export objective catalog metadata for independent AI difficulty scoring.

The export deliberately excludes existing difficulty scores, previous AI
candidates, reviews, and other answer-like editorial data. SQLite remains the
source of truth; the JSON file is a replaceable model-input artifact.
"""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scripts.catalog.database import connect, initialize


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def selected_apps(connection: Any, scope: str, limit: int) -> list[Any]:
    where = []
    parameters: list[Any] = []
    if scope != "all":
        where.append(
            "EXISTS(SELECT 1 FROM catalog_memberships m "
            "WHERE m.appid = a.appid AND m.catalog = ?)"
        )
        parameters.append(scope)
    where.append("NOT EXISTS(SELECT 1 FROM catalog_exclusions x WHERE x.appid = a.appid)")
    sql = f"""
        SELECT a.appid, a.canonical_name, a.app_type, a.release_date
        FROM apps a
        WHERE {' AND '.join(where)}
        ORDER BY
          CASE WHEN EXISTS(
            SELECT 1 FROM catalog_memberships m
            WHERE m.appid = a.appid AND m.catalog = 'active'
          ) THEN 0 ELSE 1 END,
          COALESCE((
            SELECT metric.owners_max
            FROM app_metrics metric
            WHERE metric.appid = a.appid AND metric.source = 'steamspy'
            ORDER BY metric.observed_at DESC
            LIMIT 1
          ), 0) DESC,
          a.appid
    """
    if limit > 0:
        sql += " LIMIT ?"
        parameters.append(limit)
    return list(connection.execute(sql, parameters))


def rows_for_appids(connection: Any, sql: str, appids: list[int]) -> list[Any]:
    if not appids:
        return []
    placeholders = ",".join("?" for _ in appids)
    return list(connection.execute(sql.format(appids=placeholders), appids))


def export_payload(
    connection: Any,
    *,
    scope: str = "playable",
    limit: int = 0,
    generated_at: str | None = None,
) -> dict[str, Any]:
    apps = selected_apps(connection, scope, limit)
    appids = [int(row["appid"]) for row in apps]

    names: dict[int, dict[str, str]] = {}
    for row in rows_for_appids(
        connection,
        """
        SELECT appid, locale, country, name, retrieved_at
        FROM app_names
        WHERE appid IN ({appids})
          AND lower(locale) IN ('en', 'english', 'zh', 'schinese')
        ORDER BY appid, locale,
          CASE
            WHEN lower(locale) IN ('zh', 'schinese') AND lower(country) = 'cn' THEN 0
            WHEN country = '' THEN 1
            ELSE 2
          END,
          retrieved_at DESC
        """,
        appids,
    ):
        locale = "zh-cn" if str(row["locale"]).lower() in {"zh", "schinese"} else "en"
        names.setdefault(int(row["appid"]), {}).setdefault(locale, row["name"])

    companies: dict[int, dict[str, list[str]]] = {}
    for row in rows_for_appids(
        connection,
        """
        SELECT appid, role, name
        FROM app_companies
        WHERE appid IN ({appids})
        ORDER BY appid, role, position
        """,
        appids,
    ):
        bucket = companies.setdefault(int(row["appid"]), {"developers": [], "publishers": []})
        key = "developers" if row["role"] == "developer" else "publishers"
        if row["name"] not in bucket[key]:
            bucket[key].append(row["name"])

    tags: dict[int, list[str]] = {}
    for row in rows_for_appids(
        connection,
        """
        SELECT appid, name
        FROM app_tags
        WHERE appid IN ({appids})
        ORDER BY appid, CASE WHEN source = 'pics' THEN 0 ELSE 1 END, position
        """,
        appids,
    ):
        bucket = tags.setdefault(int(row["appid"]), [])
        if row["name"] not in bucket and len(bucket) < 20:
            bucket.append(row["name"])

    metrics: dict[int, dict[str, Any]] = {}
    for row in rows_for_appids(
        connection,
        """
        SELECT appid, observed_at, ccu, peak_yesterday, peak_7d,
          owners_min, owners_max, positive, negative, reviews_total,
          average_forever_minutes, average_two_weeks_minutes,
          median_forever_minutes, median_two_weeks_minutes
        FROM app_metrics
        WHERE appid IN ({appids}) AND source = 'steamspy'
        ORDER BY appid, observed_at DESC
        """,
        appids,
    ):
        appid = int(row["appid"])
        if appid in metrics:
            continue
        reviews_total = row["reviews_total"]
        if reviews_total is None:
            reviews_total = (row["positive"] or 0) + (row["negative"] or 0)
        metrics[appid] = {
            "observedAt": row["observed_at"],
            "ownersMin": row["owners_min"],
            "ownersMax": row["owners_max"],
            "ccu": row["ccu"],
            "peakYesterday": row["peak_yesterday"],
            "peak7d": row["peak_7d"],
            "positive": row["positive"],
            "negative": row["negative"],
            "reviewsTotal": reviews_total,
            "positiveRatio": (
                round((row["positive"] or 0) / reviews_total, 6)
                if reviews_total
                else None
            ),
            "averageForeverMinutes": row["average_forever_minutes"],
            "averageTwoWeeksMinutes": row["average_two_weeks_minutes"],
            "medianForeverMinutes": row["median_forever_minutes"],
            "medianTwoWeeksMinutes": row["median_two_weeks_minutes"],
        }

    prices: dict[int, dict[str, Any]] = {}
    for row in rows_for_appids(
        connection,
        """
        SELECT appid, currency, status, regular_cents, retrieved_at
        FROM app_prices
        WHERE appid IN ({appids}) AND lower(country) = 'cn'
        ORDER BY appid, retrieved_at DESC
        """,
        appids,
    ):
        appid = int(row["appid"])
        if appid in prices:
            continue
        prices[appid] = {
            "country": "CN",
            "currency": row["currency"],
            "status": row["status"],
            "regularCents": row["regular_cents"],
            "retrievedAt": row["retrieved_at"],
        }

    games = []
    for app in apps:
        appid = int(app["appid"])
        localized_names = names.get(appid, {})
        company = companies.get(appid, {"developers": [], "publishers": []})
        games.append({
            "appId": appid,
            "name": app["canonical_name"],
            "localizedNames": {
                "en": localized_names.get("en"),
                "zh-cn": localized_names.get("zh-cn"),
            },
            "appType": app["app_type"],
            "releaseDate": app["release_date"],
            "developers": company["developers"],
            "publishers": company["publishers"],
            "tags": tags.get(appid, []),
            "regularPriceCN": prices.get(appid),
            "steamspy": metrics.get(appid),
        })

    return {
        "schemaVersion": 2,
        "purpose": "Independent SteamGuess difficulty evaluation",
        "rubricVersion": "steamguess-difficulty-v3",
        "generatedAt": generated_at or utc_now(),
        "source": "catalog.sqlite",
        "scope": scope,
        "count": len(games),
        "excludedFields": [
            "manual difficulty scores",
            "previous AI candidates",
            "reviews",
        ],
        "games": games,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path("data/catalog/catalog.sqlite"))
    parser.add_argument(
        "--scope",
        choices=("active", "playable", "search", "all"),
        default="playable",
        help="Catalog membership to export; default is the final playable pool",
    )
    parser.add_argument("--limit", type=int, default=0, help="Maximum games; 0 exports the complete scope")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/analysis/difficulty-ai-v2/input.json"),
    )
    args = parser.parse_args()
    if not args.db.exists():
        raise SystemExit(f"Catalog database not found: {args.db}")
    connection = connect(args.db)
    try:
        initialize(connection)
        payload = export_payload(connection, scope=args.scope, limit=args.limit)
    finally:
        connection.close()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"games={payload['count']} scope={args.scope} out={args.out}")


if __name__ == "__main__":
    main()
