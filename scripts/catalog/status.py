#!/usr/bin/env python3
"""Print completeness and enrichment queue status for the canonical catalog."""

from __future__ import annotations

import argparse
from pathlib import Path

from scripts.catalog.database import connect, initialize
from scripts.catalog.import_current import database_stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=Path("data/catalog/catalog.sqlite"))
    args = parser.parse_args()
    if not args.db.exists():
        raise SystemExit(f"Catalog database not found: {args.db}; run npm run data:catalog-import")
    connection = connect(args.db)
    try:
        initialize(connection)
        stats = database_stats(connection)
        for key, value in stats.items():
            print(f"{key}={value}")
        print("jobs:")
        for row in connection.execute(
            """
            SELECT service, locale, country, status, COUNT(*) AS count
            FROM enrichment_jobs
            GROUP BY service, locale, country, status
            ORDER BY service, locale, country, status
            """
        ):
            target = "/".join(part for part in (row["service"], row["locale"], row["country"]) if part)
            print(f"  {target} {row['status']}={row['count']}")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
