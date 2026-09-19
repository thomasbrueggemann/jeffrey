from datetime import date
from decimal import Decimal

from expenses.parse import Expense
from expenses.report import total, totals_by_category


def expense(day, amount, category):
    return Expense(date.fromisoformat(day), Decimal(amount), category)


def test_total_adds_decimals_exactly():
    assert total([expense("2026-01-01", "0.10", "a"), expense("2026-01-02", "0.20", "a")]) == Decimal("0.30")


def test_categories_are_largest_first():
    items = [expense("2026-01-01", "5", "food"), expense("2026-01-02", "9", "rent"), expense("2026-01-03", "5", "fun")]
    assert list(totals_by_category(items).items()) == [("rent", Decimal("9")), ("food", Decimal("5")), ("fun", Decimal("5"))]
