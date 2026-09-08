import json
from datetime import date
from pathlib import Path

import pytest

from collector.court_parser import CourtPayloadError, _date_from_yyyymmdd, parse_search_page


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "court_search_page.json"


def test_parse_search_page_maps_required_fields():
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))

    page = parse_search_page(payload)

    assert page.total_count == 282
    assert page.page_no == 1
    assert len(page.items) == 2
    first = page.items[0]
    assert first.court_office_code == "B000210"
    assert first.case_no == "2022타경101244"
    assert first.item_no == "1"
    assert first.court_name == "서울중앙지방법원"
    assert first.usage_code == "20106"
    assert first.address == "서울특별시 강남구 논현로8길 32-16 1층102호"
    assert first.appraisal_amount == 88_184_767
    assert first.minimum_sale_price == 88_184_767
    assert first.failed_bid_count == 0
    assert first.bid_datetime == "2026-07-22 10:00:00+09:00"
    lng, lat = first.location
    assert lng == pytest.approx(127.05037, abs=1e-4)
    assert lat == pytest.approx(37.47382, abs=1e-4)


def test_parse_search_page_allows_empty_page():
    page = parse_search_page(
        {"data": {"dma_pageInfo": {"totalCnt": 0, "pageNo": 3}, "dlt_srchResult": []}}
    )

    assert page.total_count == 0
    assert page.page_no == 3
    assert page.items == []


def test_parse_search_page_rejects_missing_natural_key():
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    del payload["data"]["dlt_srchResult"][0]["boCd"]

    with pytest.raises(CourtPayloadError, match="boCd"):
        parse_search_page(payload)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("02170424", None),
        ("18991231", None),
        ("19000101", date(1900, 1, 1)),
        ("99991231", None),
        ("²²²²0101", None),
    ],
)
def test_compact_date_applies_minimum_plausible_year(raw, expected):
    assert _date_from_yyyymmdd(raw) == expected


def test_search_page_does_not_format_implausible_bid_datetime():
    payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    payload["data"]["dlt_srchResult"][0]["maeGiil"] = "02170424"

    page = parse_search_page(payload)

    assert page.items[0].bid_datetime is None
