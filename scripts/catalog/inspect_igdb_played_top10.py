#!/usr/bin/env python3
"""Inspect the detail available from IGDB for the current Played Top 10.

This is a read-only research tool. It deliberately writes an analysis
snapshot, not the SteamGuess catalog database. The selected fields cover the
metadata that could plausibly replace the current Steam-centric game record:
identity, descriptions, localization, taxonomy, companies, release dates,
media, ratings, multiplayer data, and external store links.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from scripts.catalog.fetch_igdb_popularity import (
    credentials,
    fetch_access_token,
    request_json,
)


DEFAULT_TOP10 = Path("data/analysis/igdb-popularity-top500/4-played.json")
DEFAULT_JSON_OUT = Path("data/analysis/igdb-played-top10-details.json")
DEFAULT_MD_OUT = Path("data/analysis/igdb-played-top10-details.md")
IGDB_GAMES_URL = "https://api.igdb.com/v4/games"
IGDB_EXTERNAL_GAME_SOURCES_URL = (
    "https://api.igdb.com/v4/external_game_sources"
)
IGDB_EXTERNAL_GAMES_URL = "https://api.igdb.com/v4/external_games"
IGDB_GAME_LOCALIZATIONS_URL = (
    "https://api.igdb.com/v4/game_localizations"
)
STEAM_EXTERNAL_SOURCE_ID = 1

DETAIL_FIELDS = """
id,name,slug,summary,storyline,first_release_date,created_at,updated_at,
category,status,game_type,cover.*,screenshots.*,artworks.*,videos.*,websites.*,
genres.*,themes.*,game_modes.*,player_perspectives.*,platforms.*,
involved_companies.company.id,involved_companies.company.name,
involved_companies.company.country,involved_companies.developer,
involved_companies.publisher,franchises.*,collections.*,keywords.*,
rating,rating_count,total_rating,total_rating_count,similar_games,
standalone_expansions,external_games.id,external_games.uid,
external_games.name,external_games.url,external_games.platform,
external_games.external_game_source,external_games.countries,
language_supports.language.name,language_supports.language_support_type,
multiplayer_modes.*,age_ratings.*,alternative_names.*,
release_dates.*
""".replace("\n", "")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def top_game_ids(path: Path, limit: int) -> list[dict[str, Any]]:
    payload = load_json(path)
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ValueError(f"{path} does not contain rows")
    result = []
    for row in rows[:limit]:
        if not isinstance(row, dict) or row.get("igdbGameId") is None:
            continue
        result.append(
            {
                "playedRank": row.get("rank"),
                "popscore": row.get("value"),
                "igdbGameId": int(row["igdbGameId"]),
                "playedName": row.get("name"),
            }
        )
    return result


def fetch_details(
    token: str,
    client_id: str,
    game_ids: list[int],
    *,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> list[dict[str, Any]]:
    ids = ",".join(str(game_id) for game_id in sorted(set(game_ids)))
    query = f"fields {DETAIL_FIELDS}; where id = ({ids}); limit {len(set(game_ids))};"
    payload = request_json(
        IGDB_GAMES_URL,
        method="POST",
        data=query.encode("utf-8"),
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


def igdb_headers(client_id: str, token: str) -> dict[str, str]:
    return {
        "Client-ID": client_id,
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "Content-Type": "text/plain",
    }


def fetch_external_game_sources(
    token: str,
    client_id: str,
    *,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> list[dict[str, Any]]:
    """Fetch the source registry; external_game_source is an ID, not a name."""
    payload = request_json(
        IGDB_EXTERNAL_GAME_SOURCES_URL,
        method="POST",
        data=b"fields id,name; sort id asc; limit 500;",
        headers=igdb_headers(client_id, token),
        timeout=timeout,
        retries=retries,
        retry_delay=retry_delay,
    )
    if not isinstance(payload, list):
        raise RuntimeError("IGDB external_game_sources response was not an array")
    return [row for row in payload if isinstance(row, dict)]


def fetch_steam_external_games(
    token: str,
    client_id: str,
    game_ids: list[int],
    *,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> list[dict[str, Any]]:
    """Fetch Steam mappings. One IGDB game can map to multiple Steam AppIDs."""
    if not game_ids:
        return []
    ids = ",".join(str(game_id) for game_id in sorted(set(game_ids)))
    query = (
        "fields id,game,uid,name,url,year,external_game_source;"
        f"where game = ({ids}) & external_game_source = {STEAM_EXTERNAL_SOURCE_ID};"
        "limit 500;"
    )
    payload = request_json(
        IGDB_EXTERNAL_GAMES_URL,
        method="POST",
        data=query.encode("utf-8"),
        headers=igdb_headers(client_id, token),
        timeout=timeout,
        retries=retries,
        retry_delay=retry_delay,
    )
    if not isinstance(payload, list):
        raise RuntimeError("IGDB external_games response was not an array")
    return [row for row in payload if isinstance(row, dict)]


def fetch_game_localizations(
    token: str,
    client_id: str,
    game_ids: list[int],
    *,
    timeout: int,
    retries: int,
    retry_delay: float,
) -> list[dict[str, Any]]:
    """Fetch localized titles separately because they are not game fields."""
    if not game_ids:
        return []
    ids = ",".join(str(game_id) for game_id in sorted(set(game_ids)))
    query = (
        "fields id,game,name,region.name,region.identifier;"
        f"where game = ({ids}); limit 500;"
    )
    payload = request_json(
        IGDB_GAME_LOCALIZATIONS_URL,
        method="POST",
        data=query.encode("utf-8"),
        headers=igdb_headers(client_id, token),
        timeout=timeout,
        retries=retries,
        retry_delay=retry_delay,
    )
    if not isinstance(payload, list):
        raise RuntimeError("IGDB game_localizations response was not an array")
    return [row for row in payload if isinstance(row, dict)]


def count(value: Any) -> int:
    return len(value) if isinstance(value, list) else (1 if value else 0)


def names(items: Any) -> list[str]:
    if not isinstance(items, list):
        return []
    return [
        str(item.get("name") or "").strip()
        for item in items
        if isinstance(item, dict) and str(item.get("name") or "").strip()
    ]


def summarize_game(
    detail: dict[str, Any],
    source: dict[str, Any],
    *,
    steam_external_games: list[dict[str, Any]] | None = None,
    game_localizations: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    companies = detail.get("involved_companies") or []
    developers = []
    publishers = []
    for item in companies:
        if not isinstance(item, dict):
            continue
        company = item.get("company") or {}
        company_name = str(company.get("name") or "").strip()
        if not company_name:
            continue
        if item.get("developer"):
            developers.append(company_name)
        if item.get("publisher"):
            publishers.append(company_name)

    alternative_names = [
        {
            "name": item.get("name"),
            "comment": item.get("comment"),
        }
        for item in detail.get("alternative_names", [])
        if isinstance(item, dict) and item.get("name")
    ]
    languages = []
    for item in detail.get("language_supports", []):
        if not isinstance(item, dict):
            continue
        language = item.get("language")
        if isinstance(language, dict) and language.get("name"):
            languages.append(
                {
                    "language": language["name"],
                    "supportType": item.get("language_support_type"),
                }
            )

    localizations = []
    for item in game_localizations or []:
        if not isinstance(item, dict):
            continue
        region = item.get("region") or {}
        localizations.append(
            {
                "name": item.get("name"),
                "region": region.get("name") if isinstance(region, dict) else None,
                "regionIdentifier": (
                    region.get("identifier") if isinstance(region, dict) else None
                ),
            }
        )

    steam_games = []
    for item in steam_external_games or []:
        if not isinstance(item, dict):
            continue
        uid = str(item.get("uid") or "").strip()
        if not uid:
            continue
        steam_games.append(
            {
                "externalGameId": item.get("id"),
                "appid": int(uid) if uid.isdigit() else uid,
                "name": item.get("name"),
                "url": item.get("url"),
                "year": item.get("year"),
            }
        )

    return {
        **source,
        "name": detail.get("name"),
        "slug": detail.get("slug"),
        "firstReleaseDate": detail.get("first_release_date"),
        "summary": detail.get("summary"),
        "storyline": detail.get("storyline"),
        "summaryLength": len(str(detail.get("summary") or "")),
        "storylineLength": len(str(detail.get("storyline") or "")),
        "rating": detail.get("rating"),
        "ratingCount": detail.get("rating_count"),
        "totalRating": detail.get("total_rating"),
        "totalRatingCount": detail.get("total_rating_count"),
        "developers": sorted(set(developers)),
        "publishers": sorted(set(publishers)),
        "alternativeNames": alternative_names,
        "gameLocalizations": localizations,
        "languages": languages,
        "genres": names(detail.get("genres")),
        "themes": names(detail.get("themes")),
        "gameModes": names(detail.get("game_modes")),
        "playerPerspectives": names(detail.get("player_perspectives")),
        "platforms": names(detail.get("platforms")),
        "keywords": names(detail.get("keywords")),
        "franchises": names(detail.get("franchises")),
        "collections": names(detail.get("collections")),
        "coverCount": count(detail.get("cover")),
        "screenshotCount": count(detail.get("screenshots")),
        "artworkCount": count(detail.get("artworks")),
        "videoCount": count(detail.get("videos")),
        "websiteCount": count(detail.get("websites")),
        "releaseDateCount": count(detail.get("release_dates")),
        "externalGameCount": count(detail.get("external_games")),
        "steamExternalGames": steam_games,
        "steamAppIds": [
            item["appid"]
            for item in steam_games
            if isinstance(item["appid"], int)
        ],
        "ageRatingCount": count(detail.get("age_ratings")),
        "multiplayerModeCount": count(detail.get("multiplayer_modes")),
        "similarGameCount": count(detail.get("similar_games")),
        "standaloneExpansionCount": count(detail.get("standalone_expansions")),
        "detail": detail,
    }


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def preview(value: Any, length: int = 260) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= length else text[: length - 1] + "…"


def markdown_report(payload: dict[str, Any]) -> str:
    rows = payload["games"]
    coverage_fields = [
        ("summary", lambda row: bool(row["summary"])),
        ("storyline", lambda row: bool(row["storyline"])),
        ("firstReleaseDate", lambda row: row["firstReleaseDate"] is not None),
        ("rating", lambda row: row["rating"] is not None),
        ("totalRating", lambda row: row["totalRating"] is not None),
        ("developers", lambda row: bool(row["developers"])),
        ("publishers", lambda row: bool(row["publishers"])),
        ("genres", lambda row: bool(row["genres"])),
        ("themes", lambda row: bool(row["themes"])),
        ("gameModes", lambda row: bool(row["gameModes"])),
        ("platforms", lambda row: bool(row["platforms"])),
        ("alternativeNames", lambda row: bool(row["alternativeNames"])),
        ("gameLocalizations", lambda row: bool(row["gameLocalizations"])),
        ("screenshots", lambda row: row["screenshotCount"] > 0),
        ("videos", lambda row: row["videoCount"] > 0),
        ("steamAppIds", lambda row: bool(row["steamAppIds"])),
    ]
    lines = [
        "# IGDB Played Top 10 detail investigation",
        "",
        f"> Generated at `{payload['generatedAt']}`.",
        "",
        "Read-only investigation. No SQLite or public catalog files were modified.",
        "",
        "## Field coverage",
        "",
        "| Rank | Game | IGDB ID | Summary | Storyline | Alt. names | Genres | Platforms | Devs | Publishers | Screenshots | Artworks | Videos | Release dates | Languages |",
        "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['playedRank']} | {row['name']} | {row['igdbGameId']} | "
            f"{'yes' if row['summary'] else 'no'} | "
            f"{'yes' if row['storyline'] else 'no'} | {len(row['alternativeNames'])} | "
            f"{len(row['genres'])} | {len(row['platforms'])} | "
            f"{len(row['developers'])} | {len(row['publishers'])} | "
            f"{row['screenshotCount']} | {row['artworkCount']} | "
            f"{row['videoCount']} | {row['releaseDateCount']} | "
            f"{len(row['languages'])} |"
        )
    lines.extend(
        [
            "",
            "## Coverage across the requested games",
            "",
            "| Field | Present | Coverage |",
            "|---|---:|---:|",
        ]
    )
    for field, predicate in coverage_fields:
        present = sum(1 for row in rows if predicate(row))
        percentage = present / len(rows) * 100 if rows else 0
        lines.append(f"| `{field}` | {present}/{len(rows)} | {percentage:.0f}% |")

    lines.extend(
        [
            "",
            "## Steam external mappings",
            "",
            "IGDB source `1` is the Steam external-game source. A single IGDB game may map to multiple Steam AppIDs, so this is a relationship rather than a guaranteed one-to-one key.",
            "",
            "| Rank | Game | Steam AppIDs |",
            "|---:|---|---|",
        ]
    )
    for row in rows:
        appids = ", ".join(str(appid) for appid in row["steamAppIds"]) or "—"
        lines.append(f"| {row['playedRank']} | {row['name']} | {appids} |")

    lines.extend(
        [
            "",
            "## IGDB game localizations",
            "",
            "The localization endpoint is separate from `games`. It returned only region-tagged localized titles; Chinese titles in this sample are mostly found in `alternative_names`, not in the region-tagged localization records.",
            "",
            "| Rank | Game | Region-tagged localized names |",
            "|---:|---|---|",
        ]
    )
    for row in rows:
        localized = ", ".join(
            f"{item['name']} ({item['regionIdentifier'] or item['region'] or '?'})"
            for item in row["gameLocalizations"]
            if item.get("name")
        ) or "—"
        lines.append(f"| {row['playedRank']} | {row['name']} | {localized} |")

    lines.extend(["", "## Detailed records", ""])
    for row in rows:
        lines.extend(
            [
                f"### {row['playedRank']}. {row['name']}",
                "",
                f"- IGDB ID: `{row['igdbGameId']}`",
                f"- PopScore: `{row['popscore']}`",
                f"- Release timestamp: `{row['firstReleaseDate']}`",
                f"- Rating: `{row['rating']}` ({row['ratingCount']} votes); total rating `{row['totalRating']}` ({row['totalRatingCount']} votes)",
                f"- Developers: {', '.join(row['developers']) or '—'}",
                f"- Publishers: {', '.join(row['publishers']) or '—'}",
                f"- Genres: {', '.join(row['genres']) or '—'}",
                f"- Themes: {', '.join(row['themes']) or '—'}",
                f"- Modes: {', '.join(row['gameModes']) or '—'}",
                f"- Perspectives: {', '.join(row['playerPerspectives']) or '—'}",
                f"- Platforms: {', '.join(row['platforms']) or '—'}",
                f"- Franchises / collections: {', '.join(row['franchises'] + row['collections']) or '—'}",
                f"- Alternative names: {', '.join(item['name'] for item in row['alternativeNames']) or '—'}",
                f"- Region-tagged localized names: {', '.join(str(item['name']) for item in row['gameLocalizations'] if item.get('name')) or '—'}",
                f"- Languages with support records: {', '.join(item['language'] for item in row['languages']) or '—'}",
                f"- Steam AppIDs: {', '.join(str(appid) for appid in row['steamAppIds']) or '—'}",
                f"- Media counts: {row['screenshotCount']} screenshots, {row['artworkCount']} artworks, {row['videoCount']} videos, {row['websiteCount']} websites",
                f"- Other relation counts: {row['releaseDateCount']} release dates, {row['externalGameCount']} external links, {row['ageRatingCount']} age ratings, {row['multiplayerModeCount']} multiplayer records, {row['similarGameCount']} similar games",
                "",
                f"**Summary:** {preview(row['summary']) or '—'}",
                "",
                f"**Storyline:** {preview(row['storyline']) or '—'}",
                "",
            ]
        )
    lines.extend(
        [
            "## Initial assessment",
            "",
            "IGDB can provide a rich canonical game record: descriptions, taxonomy, companies, release dates, ratings, multiple media assets, alternative names, platform support, and relationship data.",
            "",
            "The main gaps for a full SteamGuess replacement are not basic metadata:",
            "",
            "- IGDB PopScore is not a raw player count or review count.",
            "- Prices and regional pricing are not part of the core IGDB game record.",
            "- Steam user reviews and review text are not part of the game record.",
            "- Chinese names are available only when present as alternative names or through a separate localization source; they are not guaranteed.",
            "- A production Steam join should use `external_games`, not name matching.",
            "- IGDB-to-Steam is not always one-to-one: one IGDB game can map to multiple Steam AppIDs or editions.",
            "- `game_localizations` is a separate endpoint and its region coverage is sparse; it should not be treated as a complete Chinese-title source.",
            "",
            "The raw API response is saved beside this report as JSON so individual fields can be inspected without another request.",
        ]
    )
    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect IGDB metadata for Played Top 10 games."
    )
    parser.add_argument("--env-file", type=Path, default=Path(".env.local"))
    parser.add_argument("--top10", type=Path, default=DEFAULT_TOP10)
    parser.add_argument("--limit", type=int, default=10)
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON_OUT)
    parser.add_argument("--md-out", type=Path, default=DEFAULT_MD_OUT)
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--retries", type=int, default=3)
    parser.add_argument("--retry-delay", type=float, default=5.0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.limit < 1:
        raise SystemExit("--limit must be positive")
    source_rows = top_game_ids(args.top10, args.limit)
    client_id, client_secret = credentials(args.env_file)
    token = fetch_access_token(
        client_id,
        client_secret,
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    details = fetch_details(
        token,
        client_id,
        [row["igdbGameId"] for row in source_rows],
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    game_ids = [row["igdbGameId"] for row in source_rows]
    external_sources = fetch_external_game_sources(
        token,
        client_id,
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    steam_external_games = fetch_steam_external_games(
        token,
        client_id,
        game_ids,
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    game_localizations = fetch_game_localizations(
        token,
        client_id,
        game_ids,
        timeout=args.timeout,
        retries=args.retries,
        retry_delay=args.retry_delay,
    )
    by_id = {int(row["id"]): row for row in details if row.get("id") is not None}
    steam_by_game: dict[int, list[dict[str, Any]]] = {}
    for row in steam_external_games:
        if row.get("game") is not None:
            steam_by_game.setdefault(int(row["game"]), []).append(row)
    localizations_by_game: dict[int, list[dict[str, Any]]] = {}
    for row in game_localizations:
        if row.get("game") is not None:
            localizations_by_game.setdefault(int(row["game"]), []).append(row)
    games = [
        summarize_game(
            detail=by_id[source["igdbGameId"]],
            source=source,
            steam_external_games=steam_by_game.get(source["igdbGameId"], []),
            game_localizations=localizations_by_game.get(
                source["igdbGameId"], []
            ),
        )
        for source in source_rows
        if source["igdbGameId"] in by_id
    ]
    payload = {
        "schemaVersion": 1,
        "source": "igdb.games",
        "generatedAt": utc_now(),
        "input": {
            "top10Snapshot": str(args.top10),
            "requestedGames": len(source_rows),
            "returnedGames": len(games),
            "fields": DETAIL_FIELDS,
            "externalGameSources": external_sources,
            "steamExternalSourceId": STEAM_EXTERNAL_SOURCE_ID,
        },
        "games": games,
    }
    write_json(args.json_out, payload)
    args.md_out.parent.mkdir(parents=True, exist_ok=True)
    args.md_out.write_text(markdown_report(payload), encoding="utf-8")
    print(
        f"requested={len(source_rows)} returned={len(games)} "
        f"json={args.json_out} markdown={args.md_out}",
        flush=True,
    )


if __name__ == "__main__":
    main()
