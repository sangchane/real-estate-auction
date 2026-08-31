"""노후도 적재기의 순수 변환부 테스트 — 승인일 파싱·나이 경계·구명 정규화·동명 조인."""

from pathlib import Path

from collector.building_age_loader import (
    age_years,
    aggregate_csv,
    normalize_gu,
    parse_apr_ym,
    parse_base_ym,
)

BASE = (2026, 8)


def test_parse_apr_ym_full_date():
    assert parse_apr_ym("1989-06-30") == (1989, 6)


def test_parse_apr_ym_missing_and_partial_are_none():
    # 원천 실측 변종: 빈 값, "1957-  -"(월 결측), "-  -"(전부 결측)는 전부 결측이다.
    assert parse_apr_ym("") is None
    assert parse_apr_ym("1957-  -") is None
    assert parse_apr_ym("-  -") is None


def test_parse_apr_ym_implausible_year_is_none():
    # 1110년 승인(실측 66행) 같은 오타 연도로 900살짜리 노후 건물을 만들지 않는다.
    assert parse_apr_ym("1110-01-01") is None
    assert parse_apr_ym("0001-01-01") is None


def test_age_boundary_same_month_counts_as_filled():
    # 기준 2026-08에 2006-08 승인은 만 20년 — 경계는 "채움"으로 센다.
    assert age_years((2006, 8), BASE) == 20
    assert age_years((2006, 9), BASE) == 19
    assert age_years((1996, 8), BASE) == 30
    assert age_years((1996, 9), BASE) == 29


def test_parse_base_ym_rejects_bad_input():
    assert parse_base_ym("2026-08") == (2026, 8)
    for bad in ("2026-8", "202608", "2026-13"):
        try:
            parse_base_ym(bad)
        except ValueError:
            continue
        raise AssertionError(f"should reject {bad!r}")


def test_normalize_gu_variants():
    # 원천 실측 변종: 정식 표기 외에 공백 없는 약칭이 실재하고, 타 시도 행도 1건 있다.
    assert normalize_gu("서울특별시 강서구") == "강서구"
    assert normalize_gu("서울시노원구") == "노원구"
    assert normalize_gu("경기도 군포시") is None


BJD_ROWS = [
    ("11500107", "방화동", "11500"),
    ("11380109", "신사동", "11380"),  # 은평구 — 동명 중복 실례
    ("11680107", "신사동", "11680"),  # 강남구
]


def _write_csv(path: Path, rows: list[tuple[str, str, str]]) -> Path:
    header = "\"시군구코드명\",\"법정동코드명\",\"사용승인일자\""
    lines = [header] + [f'"{gu}","{dong}","{apr}"' for gu, dong, apr in rows]
    path.write_text("\n".join(lines), encoding="cp949")
    return path


def test_aggregate_disambiguates_duplicate_dong_by_learned_gu(tmp_path):
    """중복 동명(신사동)은 유일 동명 투표로 학습한 구명 사전으로 가른다."""
    csv_path = _write_csv(
        tmp_path / "t.csv",
        [
            ("서울특별시 은평구", "신사동", "1980-01-01"),   # over30
            ("서울특별시 강남구", "신사동", "2010-05-01"),   # 16년 — 어느 쪽도 아님
            ("서울특별시 은평구", "역촌동", "2000-01-01"),   # 은평 투표용 유일 동명(bjd에 없음 → 미매칭)
            ("서울특별시 강서구", "방화동", "1989-06-30"),   # over30
            ("서울특별시 강서구", "방화동", ""),             # 결측
        ],
    )
    # 은평·강남 투표는 유일 동명이 있어야 생긴다 — 방화동은 강서라 신사동 표가 없고,
    # 사전 없이도 유일 동명은 그대로 붙는다. 사전이 비면 중복 동명만 미매칭이 된다.
    counts, source_rows, unmatched = aggregate_csv(csv_path, BASE, BJD_ROWS)

    assert source_rows == 5
    # 역촌동은 bjd_dong에 없어 미매칭, 신사동 2행은 사전이 없어(투표 원천 부재) 미매칭이다.
    assert unmatched == 3
    banghwa = counts["11500107"]
    assert (banghwa.total, banghwa.unknown, banghwa.over20, banghwa.over30) == (1, 1, 1, 1)


def test_aggregate_learns_gu_mapping_from_unique_dong(tmp_path):
    bjd = BJD_ROWS + [("11380101", "역촌동", "11380"), ("11680105", "삼성동", "11680")]
    csv_path = _write_csv(
        tmp_path / "t.csv",
        [
            ("서울특별시 은평구", "역촌동", "2000-01-01"),  # 은평 → 11380 투표
            ("서울특별시 강남구", "삼성동", "2000-01-01"),  # 강남 → 11680 투표
            ("서울특별시 은평구", "신사동", "1980-01-01"),
            ("서울특별시 강남구", "신사동", "2010-05-01"),
        ],
    )
    counts, source_rows, unmatched = aggregate_csv(csv_path, BASE, bjd)

    assert source_rows == 4
    assert unmatched == 0
    assert counts["11380109"].over30 == 1  # 은평 신사동
    gangnam = counts["11680107"]
    assert (gangnam.total, gangnam.over20, gangnam.over30) == (1, 0, 0)


def test_aggregate_future_year_counts_as_unknown(tmp_path):
    # 기준연월보다 미래 연도의 승인일은 오타다 — 나이를 못 매기니 결측으로 센다.
    csv_path = _write_csv(
        tmp_path / "t.csv",
        [("서울특별시 강서구", "방화동", "2030-01-01")],
    )
    counts, _, unmatched = aggregate_csv(csv_path, BASE, BJD_ROWS)

    assert unmatched == 0
    banghwa = counts["11500107"]
    assert (banghwa.total, banghwa.unknown) == (0, 1)
