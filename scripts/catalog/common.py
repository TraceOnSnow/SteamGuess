"""Shared normalization helpers for the catalog pipeline."""

from __future__ import annotations

from typing import Any

COMPANY_LEGAL_SUFFIXES = {
    "inc", "inc.", "incorporated", "ltd", "ltd.", "limited", "llc", "l.l.c.",
    "corp", "corp.", "corporation", "co", "co.", "company", "gmbh", "s.a.",
    "s.r.l.", "plc",
}


def split_company_names(values: Any) -> list[str]:
    """Split comma-delimited company fields while retaining legal suffixes."""
    raw_values = values if isinstance(values, list) else [values]
    companies: list[str] = []
    for raw in raw_values:
        for part in (item.strip() for item in str(raw or "").split(",")):
            if not part:
                continue
            if companies and part.casefold() in COMPANY_LEGAL_SUFFIXES:
                companies[-1] = f"{companies[-1]}, {part}"
            else:
                companies.append(part)

    result: list[str] = []
    seen: set[str] = set()
    for company in companies:
        key = company.casefold()
        if key not in seen:
            seen.add(key)
            result.append(company)
    return result
