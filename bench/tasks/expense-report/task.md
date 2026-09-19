Two changes to this expenses tool.

1. Add a monthly summary. `monthly_totals(expenses)` in expenses/report.py returns a dict mapping each month as `"YYYY-MM"` to the total `Decimal` spent in it, with the months in ascending order. The CLI gets `python3 -m expenses.cli monthly <file.csv>`, which prints one line per month, oldest first, as `YYYY-MM  <total with two decimals>` (two spaces between).
2. Fix a bug: `parse_line` accepts negative amounts, but refunds are not supported. A negative amount must raise `ValueError`, and so must an amount with more than two decimal places.

Keep the existing tests passing and add tests for the new behaviour.
