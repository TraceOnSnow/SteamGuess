"""Deterministically redact answer-revealing entities from Steam reviews.

Raw review text is kept intact.  This module creates ``redactedText`` beside
it so the catalog can retain the source data while publishing a safe hint.
The redactor is intentionally local and explainable: it uses names and entity
metadata already present in the catalog and never makes network requests.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import unicodedata
from pathlib import Path
from typing import Any, Iterable

REDACTION_VERSION = 1
PLACEHOLDERS = {
    "title": "[游戏名称]",
    "character": "[角色名称]",
    "franchise": "[系列名称]",
    "company": "[厂商名称]",
    "location": "[地点名称]",
    "entity": "[专有名词]",
}
_KIND_ALIASES = {
    "name": "title",
    "game": "title",
    "game_name": "title",
    "title": "title",
    "character_name": "character",
    "characters": "character",
    "protagonist": "character",
    "protagonists": "character",
    "character": "character",
    "series": "franchise",
    "franchises": "franchise",
    "franchise": "franchise",
    "company": "company",
    "developer": "company",
    "developers": "company",
    "publisher": "company",
    "publishers": "company",
    "location": "location",
    "locations": "location",
    "place": "location",
}


def _clean(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split()).strip()


def _kind(value: Any) -> str:
    return _KIND_ALIASES.get(_clean(value).casefold(), "entity")


def _iter_values(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        cleaned = _clean(value)
        if cleaned:
            yield cleaned
    elif isinstance(value, list):
        for item in value:
            yield from _iter_values(item)


def _add(entities: list[dict[str, str]], seen: set[tuple[str, str]], value: Any, kind: str) -> None:
    for text in _iter_values(value):
        key = (_clean(text).casefold(), kind)
        if key in seen:
            continue
        seen.add(key)
        entities.append({"text": text, "kind": kind})


def build_redaction_entities(game: dict[str, Any]) -> list[dict[str, str]]:
    """Build redaction entities from one catalog game.

    Besides normal catalog fields, callers may provide optional editorial
    metadata in either form::

        "reviewEntities": [{"text": "Gordon Freeman", "kind": "character"}]
        "reviewEntities": {"characters": ["Gordon Freeman"]}

    The metadata is optional, so current catalogs remain compatible while
    allowing later enrichment of protagonists, aliases, locations, and series.
    """
    entities: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    _add(entities, seen, game.get("name"), "title")
    localized = game.get("localizedNames")
    if isinstance(localized, dict):
        for value in localized.values():
            _add(entities, seen, value, "title")

    for field in ("aliases", "nameAliases", "titleAliases"):
        _add(entities, seen, game.get(field), "title")

    for field in ("developers", "publishers"):
        _add(entities, seen, game.get(field), "company")

    metadata = game.get("reviewEntities")
    if isinstance(metadata, list):
        for item in metadata:
            if isinstance(item, dict):
                _add(entities, seen, item.get("text") or item.get("name"), _kind(item.get("kind")))
            else:
                _add(entities, seen, item, "entity")
    elif isinstance(metadata, dict):
        for raw_kind, values in metadata.items():
            _add(entities, seen, values, _kind(raw_kind))

    for field, kind in (
        ("characters", "character"),
        ("protagonists", "character"),
        ("franchises", "franchise"),
        ("series", "franchise"),
        ("locations", "location"),
    ):
        _add(entities, seen, game.get(field), kind)

    # Longer phrases must win before shorter aliases (for example, a series
    # name before a one-word game title).  For equal text, title/character
    # metadata is more useful than the generic fallback.
    priority = {"title": 0, "character": 1, "franchise": 2, "location": 3, "company": 4, "entity": 5}
    return sorted(entities, key=lambda item: (-len(item["text"]), priority[item["kind"]], item["text"].casefold()))


def _pattern(text: str) -> str:
    """Match an entity without matching it inside an ASCII word.

    Chinese names do not have word separators, so they are matched directly.
    ASCII edges use a small boundary to avoid turning ``Rusty`` into
    ``[游戏名称]y`` when the answer is ``Rust``.
    """
    escaped = re.escape(text)
    left = r"(?<![A-Za-z0-9_])" if text[0].isascii() and text[0].isalnum() else ""
    right = r"(?![A-Za-z0-9_])" if text[-1].isascii() and text[-1].isalnum() else ""
    return f"{left}{escaped}{right}"


def redact_review(text: Any, entities: list[dict[str, str]] | None = None, game: dict[str, Any] | None = None) -> str:
    """Return review text with known answer entities replaced.

    Replacement is case-insensitive for Latin-script names and preserves all
    punctuation and surrounding wording.  Empty/non-string input returns an
    empty string.
    """
    result = _clean(text)
    if not result:
        return ""
    entities = entities if entities is not None else build_redaction_entities(game or {})
    for entity in entities:
        value = _clean(entity.get("text"))
        if not value:
            continue
        kind = _kind(entity.get("kind"))
        result = re.sub(_pattern(value), PLACEHOLDERS[kind], result, flags=re.IGNORECASE)
    return result


def redact_game_reviews(game: dict[str, Any]) -> int:
    """Add/update ``redactedText`` for all stored reviews in one game."""
    reviews = game.get("reviews")
    if not isinstance(reviews, dict):
        return 0
    entities = build_redaction_entities(game)
    changed = 0
    for items in reviews.values():
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            source_text = item.get("text")
            redacted = redact_review(source_text, entities)
            if redacted:
                item["redactedText"] = redacted
                item["redactionVersion"] = REDACTION_VERSION
                changed += 1
    if changed:
        game["reviewRedactionVersion"] = REDACTION_VERSION
    return changed


def redact_catalog(payload: Any) -> tuple[Any, int, int]:
    """Redact every stored review, returning payload and counts."""
    games = payload.get("games", []) if isinstance(payload, dict) else payload
    if not isinstance(games, list):
        raise ValueError("Catalog must contain a games array or be an array")
    games_seen = 0
    reviews_seen = 0
    for game in games:
        if not isinstance(game, dict) or not game.get("appId"):
            continue
        games_seen += 1
        reviews_seen += redact_game_reviews(game)
    return payload, games_seen, reviews_seen


def save_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.redaction-tmp-{os.getpid()}")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Redact answer-revealing entities from stored Steam reviews")
    parser.add_argument("--catalog", default="data/catalog/steamspy_candidates.json")
    parser.add_argument("--out", default="", help="Output path; defaults to updating --catalog atomically")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source = Path(args.catalog)
    payload = json.loads(source.read_text(encoding="utf-8"))
    payload, games, reviews = redact_catalog(payload)
    if not args.dry_run:
        save_json_atomic(Path(args.out) if args.out else source, payload)
    print(f"games={games} reviews_redacted={reviews} version={REDACTION_VERSION} dry_run={args.dry_run}")


if __name__ == "__main__":
    main()
