"""물건→법정동 공간조인의 기준(포함=ST_Contains)과 멱등성을 고정하는 테스트 (TS-41).

임시 테이블로 돌린다. PostgreSQL은 pg_temp를 먼저 찾으므로 같은 이름의 TEMP TABLE이
실제 테이블을 가린다 — 수집 배치가 3시간마다 쓰는 실제 데이터를 건드리지 않고 SQL 자체를 검증한다.
"""

import os

import psycopg
import pytest

from collector.zone_join import recompute_dong, recompute_zone, recompute_zoning


# 사각형 동 하나. 안쪽 물건 1 · 경계선 위 물건 1 · geom NULL 물건 1 로 세 경우를 한 번에 본다.
_FIXTURE_SQL = """
CREATE TEMP TABLE bjd_dong (
    bjd_code TEXT PRIMARY KEY,
    dong_name TEXT,
    sigungu TEXT,
    geom geometry(MultiPolygon, 4326)
) ON COMMIT DROP;

CREATE TEMP TABLE auction_item (
    id BIGINT PRIMARY KEY,
    address TEXT,
    geom geometry(Point, 4326)
) ON COMMIT DROP;

CREATE TEMP TABLE auction_item_dong (
    auction_item_id BIGINT PRIMARY KEY,
    bjd_code TEXT NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
) ON COMMIT DROP;

INSERT INTO bjd_dong VALUES
    ('11111111', '테스트동', '11111',
     ST_Multi(ST_GeomFromText('POLYGON((127 37,127 38,128 38,128 37,127 37))', 4326)));

INSERT INTO auction_item VALUES
    (1, '안쪽',      ST_SetSRID(ST_MakePoint(127.5, 37.5), 4326)),
    (2, '경계선 위', ST_SetSRID(ST_MakePoint(127.0, 37.5), 4326)),
    (3, '좌표 없음', NULL);
"""


def _connect_with_fixture():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")
    conn = psycopg.connect(database_url)
    conn.execute(_FIXTURE_SQL)
    return conn


def test_contains_puts_only_the_inside_item_in_the_table():
    """경계선 위 물건은 행을 만들지 않고 개수로만 남긴다.

    물건×구역(ST_Intersects, 경계 포함)과 기준이 다르다. 동은 배타적 분할이라 포함 기준을 쓰면
    한 물건이 두 동에 속하는 모순이 생긴다 (04-architecture FR-017).
    """
    conn = _connect_with_fixture()
    try:
        result = recompute_dong(conn)

        rows = conn.execute(
            "SELECT auction_item_id, bjd_code FROM auction_item_dong ORDER BY auction_item_id"
        ).fetchall()
        assert rows == [(1, "11111111")]
        # geom NULL 물건은 분모에서 빠진다 — 조인 대상이 아니라 미배정이 아니다.
        assert (result.total, result.joined, result.unmatched) == (2, 1, 1)
    finally:
        conn.rollback()
        conn.close()


def test_rerun_does_not_change_rows():
    # 같은 실행을 연달아 돌려도 행 수·값이 불변이어야 한다 (엣지 B-4).
    conn = _connect_with_fixture()
    try:
        recompute_dong(conn)
        first = conn.execute("SELECT auction_item_id, bjd_code FROM auction_item_dong").fetchall()

        second_result = recompute_dong(conn)

        second = conn.execute("SELECT auction_item_id, bjd_code FROM auction_item_dong").fetchall()
        assert first == second
        assert second_result.joined == 1
    finally:
        conn.rollback()
        conn.close()


def test_item_moved_out_of_every_dong_loses_its_row():
    """더 이상 어느 동에도 없는 물건의 옛 행을 남기면 화면이 옛 동의 노후도를 계속 말한다."""
    conn = _connect_with_fixture()
    try:
        conn.execute(
            "INSERT INTO auction_item_dong (auction_item_id, bjd_code) VALUES (2, '11111111')"
        )

        result = recompute_dong(conn)

        remaining = conn.execute("SELECT auction_item_id FROM auction_item_dong").fetchall()
        assert remaining == [(1,)]
        assert result.removed == 1
    finally:
        conn.rollback()
        conn.close()


# 구역 셋을 겹쳐 둔다: 물건 1은 두 구역에 동시에 들고(엣지 A-1), 물건 2는 경계선 위,
# 구역 3은 폴리곤이 없는 대상지(후보)라 아무 물건에도 붙지 않아야 한다.
_ZONE_FIXTURE_SQL = """
CREATE TEMP TABLE redevelopment_zone (
    id BIGINT PRIMARY KEY,
    source TEXT,
    source_zone_id TEXT,
    zone_kind TEXT,
    geom geometry(MultiPolygon, 4326)
) ON COMMIT DROP;

CREATE TEMP TABLE auction_item_zone (
    auction_item_id BIGINT NOT NULL,
    zone_id BIGINT NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auction_item_id, zone_id)
) ON COMMIT DROP;

INSERT INTO redevelopment_zone VALUES
    (10, 'NSDI_UD602', 'A', 'REDEV',
     ST_Multi(ST_GeomFromText('POLYGON((127 37,127 38,128 38,128 37,127 37))', 4326))),
    (11, 'NSDI_UD602', 'B', 'REDEV',
     ST_Multi(ST_GeomFromText('POLYGON((127.4 37.4,127.4 37.6,127.6 37.6,127.6 37.4,127.4 37.4))', 4326))),
    (12, 'NSDI_UD602', 'C', 'REDEV', NULL);
"""


def _connect_with_zone_fixture():
    conn = _connect_with_fixture()
    conn.execute(_ZONE_FIXTURE_SQL)
    return conn


def test_intersects_puts_the_boundary_item_in_and_allows_overlap():
    """물건×구역은 ST_Intersects다 — 경계선 위 물건도 포함하고, 한 물건이 여러 구역에 붙는다.

    구역은 배타적 분할이 아니라 실제로 겹치므로 포함이 안전하다 (05 데이터 규칙, 엣지 A-1·A-3).
    법정동 조인(ST_Contains)과 기준이 다른 점이 여기서 갈린다.
    """
    conn = _connect_with_zone_fixture()
    try:
        result = recompute_zone(conn)

        rows = conn.execute(
            "SELECT auction_item_id, zone_id FROM auction_item_zone ORDER BY auction_item_id, zone_id"
        ).fetchall()
        # 물건 1은 구역 10·11 둘 다, 경계선 위 물건 2는 구역 10에만, 폴리곤 없는 구역 12는 아무데도.
        assert rows == [(1, 10), (1, 11), (2, 10)]
        assert (result.items, result.zones, result.pairs) == (2, 2, 3)
    finally:
        conn.rollback()
        conn.close()


def test_zone_rerun_does_not_change_rows():
    # 같은 실행을 연달아 돌려도 행 수·값이 불변이어야 한다 (엣지 B-4).
    conn = _connect_with_zone_fixture()
    try:
        recompute_zone(conn)
        first = conn.execute("SELECT auction_item_id, zone_id FROM auction_item_zone").fetchall()

        second_result = recompute_zone(conn)

        second = conn.execute("SELECT auction_item_id, zone_id FROM auction_item_zone").fetchall()
        assert sorted(first) == sorted(second)
        assert second_result.pairs == 3
    finally:
        conn.rollback()
        conn.close()


def test_pair_that_no_longer_overlaps_loses_its_row():
    """구역 경계가 줄어 이제 겹치지 않는 짝을 남기면 화면이 옛 구역을 계속 사실로 말한다."""
    conn = _connect_with_zone_fixture()
    try:
        conn.execute("INSERT INTO auction_item_zone (auction_item_id, zone_id) VALUES (3, 10)")

        result = recompute_zone(conn)

        remaining = conn.execute(
            "SELECT auction_item_id, zone_id FROM auction_item_zone ORDER BY auction_item_id, zone_id"
        ).fetchall()
        assert remaining == [(1, 10), (1, 11), (2, 10)]
        assert result.removed == 1
    finally:
        conn.rollback()
        conn.close()


# 용도지역 셋: 폴리곤 20·21은 같은 자리(재고시 중복 — 실측에서 다중 매치의 주원인), 물건 2는
# 폴리곤 20의 경계선 위, 폴리곤 22는 도형 없는 행(원천 실측 1건)이라 아무 물건에도 붙지 않아야 한다.
_ZONING_FIXTURE_SQL = """
CREATE TEMP TABLE zoning_district (
    id BIGINT PRIMARY KEY,
    source TEXT,
    base_ym TEXT,
    zoning_bucket TEXT,
    geom geometry(MultiPolygon, 4326)
) ON COMMIT DROP;

CREATE TEMP TABLE auction_item_zoning (
    auction_item_id BIGINT NOT NULL,
    zoning_district_id BIGINT NOT NULL,
    computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auction_item_id, zoning_district_id)
) ON COMMIT DROP;

INSERT INTO zoning_district VALUES
    (20, 'SEOUL_OA21136', '2026-02', 'RES_GENERAL_2',
     ST_Multi(ST_GeomFromText('POLYGON((127 37,127 38,128 38,128 37,127 37))', 4326))),
    (21, 'SEOUL_OA21136', '2026-02', 'RES_GENERAL_2',
     ST_Multi(ST_GeomFromText('POLYGON((127.4 37.4,127.4 37.6,127.6 37.6,127.6 37.4,127.4 37.4))', 4326))),
    (22, 'SEOUL_OA21136', '2026-02', 'OTHER', NULL);
"""


def _connect_with_zoning_fixture():
    conn = _connect_with_fixture()
    conn.execute(_ZONING_FIXTURE_SQL)
    return conn


def test_zoning_intersects_keeps_overlapping_notices_and_the_boundary_item():
    """물건×용도지역은 ST_Intersects 쌍 테이블이다 — 물건당 한 행이 아니다.

    용도지역은 원칙상 배타 분할이지만 원천은 같은 자리의 옛 고시·재고시 폴리곤을 함께 담아
    (실측 2026-09-01: 528물건 10.6%가 폴리곤 두 장 이상의 안쪽) 물건당 한 행을 강제하면
    남길 고시를 추측으로 고르게 된다. 두 행 다 사실이므로 둘 다 남긴다.
    """
    conn = _connect_with_zoning_fixture()
    try:
        result = recompute_zoning(conn)

        rows = conn.execute(
            "SELECT auction_item_id, zoning_district_id FROM auction_item_zoning"
            " ORDER BY auction_item_id, zoning_district_id"
        ).fetchall()
        # 물건 1은 겹친 폴리곤 20·21 둘 다, 경계선 위 물건 2는 20에만, 도형 없는 22는 아무데도.
        assert rows == [(1, 20), (1, 21), (2, 20)]
        assert (result.items, result.districts, result.pairs) == (2, 2, 3)
    finally:
        conn.rollback()
        conn.close()


def test_zoning_rerun_does_not_change_rows():
    # 같은 실행을 연달아 돌려도 행 수·값이 불변이어야 한다 (엣지 B-4).
    conn = _connect_with_zoning_fixture()
    try:
        recompute_zoning(conn)
        first = conn.execute(
            "SELECT auction_item_id, zoning_district_id FROM auction_item_zoning"
        ).fetchall()

        second_result = recompute_zoning(conn)

        second = conn.execute(
            "SELECT auction_item_id, zoning_district_id FROM auction_item_zoning"
        ).fetchall()
        assert sorted(first) == sorted(second)
        assert second_result.pairs == 3
    finally:
        conn.rollback()
        conn.close()


def test_zoning_pair_that_no_longer_overlaps_loses_its_row():
    """전량 교체로 id가 바뀌거나 좌표가 고쳐져 이제 안 겹치는 짝을 남기면 화면이 옛 용도지역을 계속 사실로 말한다."""
    conn = _connect_with_zoning_fixture()
    try:
        conn.execute(
            "INSERT INTO auction_item_zoning (auction_item_id, zoning_district_id) VALUES (3, 20)"
        )

        result = recompute_zoning(conn)

        remaining = conn.execute(
            "SELECT auction_item_id, zoning_district_id FROM auction_item_zoning"
            " ORDER BY auction_item_id, zoning_district_id"
        ).fetchall()
        assert remaining == [(1, 20), (1, 21), (2, 20)]
        assert result.removed == 1
    finally:
        conn.rollback()
        conn.close()
