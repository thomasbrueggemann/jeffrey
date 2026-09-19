"""python3 -m expenses.cli <command> <file.csv>"""
from __future__ import annotations

import sys

from .parse import read_file
from .report import monthly_totals, total, totals_by_category

USAGE = "usage: python3 -m expenses.cli {total,categories,monthly} <file.csv>"


def main(argv: list[str], out=print) -> int:
    if len(argv) != 2:
        out(USAGE)
        return 2
    command, path = argv
    expenses = read_file(path)
    if command == "total":
        out(f"{total(expenses):.2f}")
    elif command == "categories":
        for category, amount in totals_by_category(expenses).items():
            out(f"{category}  {amount:.2f}")
    elif command == "monthly":
        for month, amount in monthly_totals(expenses).items():
            out(f"{month}  {amount:.2f}")
    else:
        out(USAGE)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
