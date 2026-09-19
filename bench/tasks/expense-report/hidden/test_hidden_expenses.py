import subprocess
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from expenses.parse import Expense, parse_line
from expenses.report import totals_by_category

ROOT = Path(__file__).resolve().parent.parent


def expense(day, amount, category="misc"):
    return Expense(date.fromisoformat(day), Decimal(amount), category)


def test_monthly_totals_group_by_month_oldest_first():
    from expenses.report import monthly_totals  # imported here: a missing function fails this test, not the file

    items = [
        expense("2026-03-31", "10.00"),
        expense("2025-12-01", "1.25"),
        expense("2026-03-01", "0.05"),
        expense("2026-01-15", "7"),
    ]
    result = monthly_totals(items)
    assert list(result.items()) == [("2025-12", Decimal("1.25")), ("2026-01", Decimal("7")), ("2026-03", Decimal("10.05"))]
    assert all(isinstance(value, Decimal) for value in result.values())


def test_monthly_totals_of_nothing_is_empty():
    from expenses.report import monthly_totals

    assert monthly_totals([]) == {}


def test_negative_amounts_are_rejected():
    with pytest.raises(ValueError):
        parse_line(["2026-01-01", "-5.00", "food"])
    with pytest.raises(ValueError):
        parse_line(["2026-01-01", " -0.01", "food"])


def test_more_than_two_decimals_is_rejected():
    with pytest.raises(ValueError):
        parse_line(["2026-01-01", "1.005", "food"])
    assert parse_line(["2026-01-01", "1.5", "food"]).amount == Decimal("1.5")
    assert parse_line(["2026-01-01", "0", "food"]).amount == Decimal("0")


def test_the_cli_prints_monthly_totals(tmp_path):
    csv = tmp_path / "x.csv"
    csv.write_text("date,amount,category,note\n2026-02-03,4.5,food,\n2026-01-09,10,rent,\n2026-02-20,0.25,fun,\n")
    result = subprocess.run([sys.executable, "-m", "expenses.cli", "monthly", str(csv)], cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert result.stdout.splitlines() == ["2026-01  10.00", "2026-02  4.75"]


def test_existing_behaviour_is_intact():
    items = [expense("2026-01-01", "5", "food"), expense("2026-01-02", "9", "rent")]
    assert list(totals_by_category(items)) == ["rent", "food"]
    with pytest.raises(ValueError):
        parse_line(["2026-01-01", "x", "food"])
