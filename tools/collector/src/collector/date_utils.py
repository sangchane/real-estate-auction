from __future__ import annotations

from datetime import date
from typing import Any


# Court records can contain old rights, but years before 1900 in observed responses
# have been truncation/OCR artifacts (for example 0214 parsed from 20214).
MIN_PLAUSIBLE_DATE_YEAR = 1900
# Auction schedules may legitimately cross a year boundary. One year of headroom keeps
# those records while rejecting clearly corrupt values such as 2029/9999 observed in 2026.
MAX_PLAUSIBLE_DATE_YEAR = date.today().year + 1


def plausible_date(year: int, month: int, day: int) -> date | None:
    if year < MIN_PLAUSIBLE_DATE_YEAR or year > MAX_PLAUSIBLE_DATE_YEAR:
        return None
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_yyyymmdd(value: Any) -> date | None:
    text = str(value).strip() if value is not None else ""
    if len(text) != 8 or not text.isascii() or not text.isdigit():
        return None
    return plausible_date(int(text[0:4]), int(text[4:6]), int(text[6:8]))
