"""Parsing the CSV export. Amounts are Decimals, never floats."""
from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Iterable, Iterator


@dataclass(frozen=True)
class Expense:
    day: date
    amount: Decimal
    category: str
    note: str = ""


def parse_line(fields: list[str]) -> Expense:
    """One CSV row -> Expense. Raises ValueError on a malformed row."""
    if len(fields) < 3:
        raise ValueError(f"expected at least 3 fields, got {len(fields)}")
    raw_day, raw_amount, category, *rest = fields
    try:
        day = date.fromisoformat(raw_day.strip())
    except ValueError as error:
        raise ValueError(f"bad date {raw_day!r}") from error
    try:
        amount = Decimal(raw_amount.strip())
    except InvalidOperation as error:
        raise ValueError(f"bad amount {raw_amount!r}") from error
    category = category.strip().lower()
    if not category:
        raise ValueError("empty category")
    return Expense(day, amount, category, ",".join(rest).strip())


def parse_rows(rows: Iterable[list[str]]) -> Iterator[Expense]:
    """Skip blank rows and a header row starting with 'date'."""
    for fields in rows:
        if not fields or not "".join(fields).strip():
            continue
        if fields[0].strip().lower() == "date":
            continue
        yield parse_line(fields)


def read_file(path: str) -> list[Expense]:
    with open(path, newline="", encoding="utf-8") as handle:
        return list(parse_rows(csv.reader(handle)))
