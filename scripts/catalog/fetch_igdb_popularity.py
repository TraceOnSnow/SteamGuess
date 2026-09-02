#!/usr/bin/env python3
"""Fetch an IGDB PopScore primitive ranking for later catalog analysis.

This is intentionally independent from the SteamGuess catalog pipeline. It
fetches one IGDB PopScore primitive and enriches its game IDs with names. The
``value`` field is IGDB's dimensionless PopScore value: it is useful for
ordering and combining rows from the same primitive, but it is not a raw
review count, player count, percentage, or currency amount. The result is
kept in a small JSON snapshot. Credentials are read from the
environment or from ``.env.local``; environment variables take precedence.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


DEFAULT_ENV_FILE = Path(".env.local")
DEFAULT_OUTPUT = Path("data/raw/igdb/popularity.json")
TOKEN_URL = "https://id.twitch.tv/oauth2/token"
GAMES_URL = "https://api.igdb.com/v4/games"
POPULARITY_TYPES_URL = "https://api.igdb.com/v4/popularity_types"
POPULARITY_PRIMITIVES_URL = "https://api.igdb.com/v4/popularity_primitives"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_env_file(path: Path) -> dict[str, str]:
    """Read the small KEY=VALUE subset used by local dotenv files."""
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise ValueError(f"{path}:{line_number}: expected KEY=VALUE")
        key, value = stripped.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key:
            values[key] = value
    return values


def credentials(env_file: Path) -> tuple[str, str]:
    local = load_env_file(env_file)
    client_id = os.environ.get("IGDB_CLIENT_ID") or local.get("IGDB_CLIENT_ID", "")
    client_secret = os.environ.get("IGDB_CLIENT_SECRET") or local.get(
        "IGDB_CLIENT_SECRET", ""
    )
    if not client_id or not client_secret:
        raise SystemExit(
            "IGDB_CLIENT_ID and IGDB_CLIENT_SECRET are required; "
            f"configure them in {env_file} or the shell environment"
        )
    return client_id, client_secret


def request_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> Any:
    last_error: Exception | None = None
    for attempt in range(retries + 1):
        try:
            request = Request(url, data=data, headers=headers or {}, method=method)
            with urlopen(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace").strip()
            last_error = RuntimeError(
                f"HTTP {error.code} {error.reason}: {detail or 'no response body'}"
            )
            retryable = error.code == 429 or error.code >= 500
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            retryable = True
        if not retryable or attempt >= retries:
            break
        wait = retry_delay * (2**attempt)
        retry_after = getattr(last_error, "headers", {}).get("Retry-After")
        if retry_after:
            try:
                wait = max(wait, float(retry_after))
            except ValueError:
                pass
        time.sleep(wait)
    raise RuntimeError(f"IGDB request failed: {last_error}") from last_error


def fetch_access_token(
    client_id: str,
    client_secret: str,
    *,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> str:
    query = urlencode(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
        }
    ).encode("ascii")
    payload = request_json(
        TOKEN_URL,
        method="POST",
        data=query,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=timeout,
        retries=retries,
        retry_delay=retry_delay,
    )
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not token:
        raise RuntimeError("Twitch token response did not contain access_token")
    return str(token)


def fetch_page(
    token: str,
    client_id: str,
    *,
    offset: int,
    limit: int,
    popularity_type: int,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> list[dict[str, Any]]:
    query = (
        "fields game_id,value,popularity_type,calculated_at;"
        "sort value desc;"
        f"where popularity_type = {popularity_type};"
        f"limit {limit}; offset {offset};"
    ).encode("utf-8")
    payload = request_json(
        POPULARITY_PRIMITIVES_URL,
        method="POST",
        data=query,
        headers={
            "Client-ID": client_id,
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "text/plain",
        },
        timeout=timeout,
        retries=retries,
        retry_delay=retry_delay,
    )
    if not isinstance(payload, list):
        raise RuntimeError("IGDB games response was not an array")
    return [row for row in payload if isinstance(row, dict)]


def fetch_popularity_types(
    token: str,
    client_id: str,
    *,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> list[dict[str, Any]]:
    payload = request_json(
        POPULARITY_TYPES_URL,
        method="POST",
        data=b"fields id,name; sort id asc;",
        headers={
            "Client-ID": client_id,
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "text/plain",
        },
        timeout=timeout,
        retries=retries,
        retry_delay=retry_delay,
    )
    if not isinstance(payload, list):
        raise RuntimeError("IGDB popularity_types response was not an array")
    return [row for row in payload if isinstance(row, dict)]


def resolve_popularity_type(
    requested: str, available: list[dict[str, Any]]
) -> tuple[int, str]:
    try:
        requested_id = int(requested)
    except ValueError:
        requested_id = None
    if requested_id is not None:
        for item in available:
            if int(item.get("id", -1)) == requested_id:
                return requested_id, str(item.get("name") or requested)
        return requested_id, requested

    wanted = requested.casefold().strip()
    for item in available:
        if str(item.get("name") or "").casefold() == wanted:
            return int(item["id"]), str(item["name"])
    names = ", ".join(
        f"{item.get('id')}: {item.get('name')}" for item in available
    )
    raise SystemExit(f"Unknown --popularity-type {requested!r}. Available: {names}")


def fetch_games(
    token: str,
    client_id: str,
    game_ids: list[int],
    *,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> dict[int, dict[str, Any]]:
    if not game_ids:
        return {}
    ids = ",".join(str(game_id) for game_id in sorted(set(game_ids)))
    query = (
        "fields id,name,first_release_date,cover.url;"
        f"where id = ({ids}); limit {len(set(game_ids))};"
    ).encode("utf-8")
    payload = request_json(
        GAMES_URL,
        method="POST",
        data=query,
        headers={
            "Client-ID": client_id,
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "text/plain",
        },
        timeout=timeout,
        retries=retries,
        retry_delay=retry_delay,
    )
    if not isinstance(payload, list):
        raise RuntimeError("IGDB games response was not an array")
    return {
        int(row["id"]): row
        for row in payload
        if isinstance(row, dict) and row.get("id") is not None
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, delete=False
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch IGDB games ordered by calculated popularity (popscore)."
    )
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--list-types",
        action="store_true",
        help="Print the currently available popularity type IDs and exit.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=3000,
        help="Number of rows to fetch for this popularity type (default: 3000).",
    )
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument(
        "--popularity-type",
        default="24hr Peak Players",
        help=(
            "IGDB popularity type name or ID. Common values: "
            "'24hr Peak Players', 'Total Reviews', 'Visits'."
        ),
    )
    parser.add_argument("--delay", type=float, default=0.25)
    parser.add_argument("--timeout", type=int, default=45)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--retry-delay", type=float, default=5.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be positive")
    if not 1 <= args.batch_size <= 500:
        raise SystemExit("--batch-size must be between 1 and 500")

    client_id, client_secret = credentials(args.env_file)
    token = fetch_access_token(
        client_id,
        client_secret,
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    popularity_types = fetch_popularity_types(
        token,
        client_id,
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    if args.list_types:
        for item in popularity_types:
            print(f"{item.get('id')}\t{item.get('name')}")
        return
    popularity_type_id, popularity_type_name = resolve_popularity_type(
        args.popularity_type, popularity_types
    )

    rows: list[dict[str, Any]] = []
    for offset in range(0, args.limit, args.batch_size):
        if rows and args.delay > 0:
            time.sleep(args.delay)
        page = fetch_page(
            token,
            client_id,
            offset=offset,
            limit=min(args.batch_size, args.limit - offset),
            popularity_type=popularity_type_id,
            timeout=args.timeout,
            retries=args.retries,
            retry_delay=args.retry_delay,
        )
        rows.extend(page)
        print(f"offset={offset} rows={len(page)} total={len(rows)}", flush=True)
        if len(page) < min(args.batch_size, args.limit - offset):
            break

    game_details: dict[int, dict[str, Any]] = {}
    for offset in range(0, len(rows), args.batch_size):
        if offset:
            time.sleep(args.delay)
        game_details.update(
            fetch_games(
                token,
                client_id,
                [int(row["game_id"]) for row in rows[offset : offset + args.batch_size]],
                timeout=args.timeout,
                retries=args.retries,
                retry_delay=args.retry_delay,
            )
        )

    output_rows = []
    for rank, row in enumerate(rows[: args.limit], start=1):
        game_id = int(row["game_id"])
        detail = game_details.get(game_id, {})
        output_rows.append(
            {
                "rank": rank,
                "igdbGameId": game_id,
                "name": detail.get("name"),
                "popularityType": popularity_type_name,
                "popularityTypeId": popularity_type_id,
                "value": row.get("value"),
                "calculatedAt": row.get("calculated_at"),
                "firstReleaseDate": detail.get("first_release_date"),
                "coverUrl": detail.get("cover", {}).get("url")
                if isinstance(detail.get("cover"), dict)
                else None,
            }
        )

    payload = {
        "schemaVersion": 1,
        "source": "igdb.popularity_primitives",
        "metric": "popscore",
        "valueSemantics": (
            "IGDB PopScore primitive value; use for same-type ranking or "
            "weighted combinations, not as a raw count or percentage"
        ),
        "generatedAt": utc_now(),
        "popularityType": {
            "id": popularity_type_id,
            "name": popularity_type_name,
        },
        "requestedLimit": args.limit,
        "fetchedRows": len(output_rows),
        "rows": output_rows,
    }
    write_json(args.out, payload)
    print(f"wrote={args.out} rows={len(payload['rows'])}", flush=True)


if __name__ == "__main__":
    main()
