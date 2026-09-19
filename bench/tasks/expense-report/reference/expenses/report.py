"""Summaries over parsed expenses."""
from __future__ import annotations

from collections import defaultdict
from decimal import Decimal
from typing import Iterable

from .parse import Expense


def total(expenses: Iterable[Expense]) -> Decimal:
    return sum((expense.amount for expense in expenses), Decimal("0"))


def totals_by_category(expenses: Iterable[Expense]) -> dict[str, Decimal]:
    """Category -> total, largest first; ties by name."""
    sums: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for expense in expenses:
        sums[expense.category] += expense.amount
    return dict(sorted(sums.items(), key=lambda item: (-item[1], item[0])))


def monthly_totals(expenses: Iterable[Expense]) -> dict[str, Decimal]:
    """'YYYY-MM' -> total spent that month, oldest month first."""
    sums: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for expense in expenses:
        sums[expense.day.strftime("%Y-%m")] += expense.amount
    return dict(sorted(sums.items()))
