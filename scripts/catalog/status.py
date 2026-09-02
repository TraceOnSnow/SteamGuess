#!/usr/bin/env python3
"""Print completeness status for the converged one-table catalog."""

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
        print("pool:")
        for row in connection.execute(
            "SELECT pool_status, COUNT(*) AS count FROM games GROUP BY pool_status ORDER BY pool_status"
        ):
            print(f"  {row['pool_status']}={row['count']}")
    finally:
        connection.close()


if __name__ == "__main__":
    main()
