from datetime import date
from decimal import Decimal

import pytest

from expenses.parse import Expense, parse_line, parse_rows


def test_a_row_becomes_an_expense():
    assert parse_line(["2026-03-04", "12.50", " Food ", "lunch"]) == Expense(date(2026, 3, 4), Decimal("12.50"), "food", "lunch")


def test_malformed_rows_raise():
    for fields in (["2026-03-04", "12.50"], ["yesterday", "1", "x"], ["2026-03-04", "lots", "x"], ["2026-03-04", "1", " "]):
        with pytest.raises(ValueError):
            parse_line(fields)


def test_header_and_blank_rows_are_skipped():
    rows = [["date", "amount", "category"], [], ["2026-01-01", "3", "fun"]]
    assert [e.amount for e in parse_rows(rows)] == [Decimal("3")]
