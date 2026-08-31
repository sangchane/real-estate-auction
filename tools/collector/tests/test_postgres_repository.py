import json
import os
from dataclasses import replace
from datetime import date
from pathlib import Path

import psycopg
import pytest

from collector.court_parser import (
    SOURCE_CASE_SEARCH,
    ItemNotice,
    SaleResult,
    parse_photo_page,
    parse_search_page,
)
from collector.notice_tenant_parser import NoticeTenant
from collector.postgres_repository import PostgresAuctionRepository, run_migrations


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "court_search_page.json"


def _reset_or_skip(repository: PostgresAuctionRepository) -> None:
    """빈 DB에서만 파괴적 테스트를 돌린다.

    개발 DB를 그대로 가리키고 실행하면 수집분이 통째로 날아간다. 물건·사진은 다시 받으면 되지만
    명세서와 점유자 표는 기일이 지나면 영구 소실이다(WP-11 §4-3) — 실제로 2026-07-31에 날렸다.
    """
    try:
        repository.truncate_for_test()
    except RuntimeError as exc:
        pytest.skip(str(exc))


def test_postgres_repository_requires_database_url():
    with pytest.raises(ValueError):
        PostgresAuctionRepository("")


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_DB_TESTS") != "1",
    reason="set COLLECTOR_RUN_DB_TESTS=1 to run PostGIS integration tests",
)
def test_postgres_repository_upsert_and_bbox_smoke():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")

    repository = PostgresAuctionRepository(database_url)
    run_migrations(database_url)
    _reset_or_skip(repository)

    page = parse_search_page(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))

    first = repository.upsert_items(page.items)
    second = repository.upsert_items(page.items)
    seoul_items = repository.find_items_in_bbox(
        min_lng=126.7,
        min_lat=37.3,
        max_lng=127.2,
        max_lat=37.8,
    )

    assert first.inserted == 2
    assert second.inserted == 0
    assert second.skipped == 2
    assert len(seoul_items) == 2


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_DB_TESTS") != "1",
    reason="set COLLECTOR_RUN_DB_TESTS=1 to run PostGIS integration tests",
)
def test_postgres_sale_result_upsert_is_idempotent_including_null_amount():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")

    repository = PostgresAuctionRepository(database_url)
    run_migrations(database_url)
    _reset_or_skip(repository)
    page = parse_search_page(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    repository.upsert_items(page.items)

    # fixture의 매각기일(2026-07-16/22)은 이미 지났고 결과가 없다 — 둘 다 backfill 대상
    assert len(repository.find_items_pending_sale_result()) == 2

    results = [
        SaleResult(
            court_office_code="B000210",
            case_no="2023타경4722",
            item_no="1",
            dxdy_date=date(2026, 7, 16),
            dxdy_kind_code="01",
            result_code="001",
            sale_amount=5_210_000,
            minimum_sale_price=5_201_000,
            failed_bid_count=None,
            source=SOURCE_CASE_SEARCH,
        ),
        # 유찰 — 낙찰가 NULL이어도 재실행 시 행이 늘면 안 된다 (UNIQUE 제약은 NULL을 구분 못함)
        SaleResult(
            court_office_code="B000210",
            case_no="2022타경101244",
            item_no="1",
            dxdy_date=date(2026, 7, 22),
            dxdy_kind_code="01",
            result_code="002",
            sale_amount=None,
            minimum_sale_price=88_184_767,
            failed_bid_count=1,
            source=SOURCE_CASE_SEARCH,
        ),
        # DB에 없는 물건 — 조용히 건너뛴다
        SaleResult(
            court_office_code="B000210",
            case_no="2024타경999999",
            item_no="1",
            dxdy_date=date(2026, 7, 22),
            dxdy_kind_code="01",
            result_code="001",
            sale_amount=1,
            minimum_sale_price=None,
            failed_bid_count=None,
            source=SOURCE_CASE_SEARCH,
        ),
    ]

    first = repository.upsert_sale_results(results)
    second = repository.upsert_sale_results(results)

    assert first.inserted == 2
    assert first.skipped == 1
    assert second.inserted == 0
    assert second.skipped == 3
    # 결과가 채워진 물건은 더 이상 backfill 대상이 아니다
    assert repository.find_items_pending_sale_result() == []


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_DB_TESTS") != "1",
    reason="set COLLECTOR_RUN_DB_TESTS=1 to run PostGIS integration tests",
)
def test_postgres_notice_upsert_is_idempotent_and_updates_changed_fields():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")

    repository = PostgresAuctionRepository(database_url)
    run_migrations(database_url)
    _reset_or_skip(repository)
    page = parse_search_page(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    repository.upsert_items(page.items)

    notice = ItemNotice(
        court_office_code="B000210",
        case_no="2022타경101244",
        item_no="1",
        document_date=date(2026, 7, 3),
        baseline_raw="집합건물 : 2008.07.09 근저당권",
        baseline_date=date(2008, 7, 9),
        distribution_demand_deadline=date(2025, 3, 10),
        assumed_rights_kind="NONE",
        risk_flags=["LAND_SEPARATE_REGISTRATION"],
        lien_claim_amount=None,
    )
    # 작성일이 없는 명세서도 재실행 시 중복되면 안 된다 (UNIQUE 제약은 NULL을 구분 못한다)
    undated = ItemNotice(
        court_office_code="B000210",
        case_no="2023타경4722",
        item_no="1",
        document_date=None,
        baseline_raw="2024.12.11. 경매개시결정",
        baseline_date=date(2024, 12, 11),
        distribution_demand_deadline=None,
        assumed_rights_kind=None,
        risk_flags=[],
        lien_claim_amount=None,
    )
    # DB에 없는 물건 — 조용히 건너뛴다
    unknown = ItemNotice(
        court_office_code="B000210",
        case_no="2024타경999999",
        item_no="1",
        document_date=date(2026, 7, 3),
        baseline_raw=None,
        baseline_date=None,
        distribution_demand_deadline=None,
        assumed_rights_kind=None,
        risk_flags=[],
        lien_claim_amount=None,
    )

    first = repository.upsert_notices([notice, undated, unknown])
    second = repository.upsert_notices([notice, undated, unknown])
    # risk_flags 배열 변경·유치권 금액 추가가 updated로 잡혀야 한다 (TEXT[]는 Python 리스트로 비교)
    third = repository.upsert_notices(
        [
            replace(
                notice,
                risk_flags=["LAND_SEPARATE_REGISTRATION", "LIEN_CLAIM"],
                lien_claim_amount=879_596_895,
            ),
            undated,
            unknown,
        ]
    )

    assert (first.inserted, first.updated, first.skipped) == (2, 0, 1)
    assert (second.inserted, second.updated, second.skipped) == (0, 0, 3)
    assert (third.inserted, third.updated, third.skipped) == (0, 1, 2)
    # daily 스킵 필터가 쓰는 키 집합 — (물건, 그 명세서의 기일)이다
    assert repository.find_item_keys_with_notice() == {
        ("B000210", "2022타경101244", "1", None),
        ("B000210", "2023타경4722", "1", None),
    }

    # 유찰로 기일이 바뀌면 그 기일 키가 없어야 daily가 다시 받는다 (§4-13)
    rolled = replace(notice, bid_date=date(2026, 9, 7), document_date=date(2026, 8, 20))
    repository.upsert_notices([rolled])
    keys = repository.find_item_keys_with_notice()
    assert ("B000210", "2022타경101244", "1", date(2026, 9, 7)) in keys
    assert ("B000210", "2022타경101244", "1", date(2026, 8, 3)) not in keys


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_DB_TESTS") != "1",
    reason="set COLLECTOR_RUN_DB_TESTS=1 to run PostGIS integration tests",
)
def test_postgres_notice_tenants_are_replaced_not_appended():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")

    repository = PostgresAuctionRepository(database_url)
    run_migrations(database_url)
    _reset_or_skip(repository)
    page = parse_search_page(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    repository.upsert_items(page.items)

    tenants = (
        NoticeTenant(
            row_no=1,
            tenant_seq=1,
            tenant_name="홍길동",
            source_kind="등기사항전부증명서",
            occupied_part="206호",
            possession_basis="주거 주택임차권자",
            lease_period="2021.06.04~",
            deposit_amount=230_000_000,
            monthly_rent=None,
            move_in_date=date(2021, 6, 4),
            fixed_date=date(2021, 6, 4),
            demanded_distribution=None,
            demanded_distribution_date=None,
        ),
        NoticeTenant(
            row_no=2,
            tenant_seq=1,
            tenant_name="홍길동",
            source_kind="권리신고",
            occupied_part="206호",
            possession_basis="주거 임차인",
            lease_period=None,
            deposit_amount=230_000_000,
            monthly_rent=None,
            move_in_date=date(2021, 6, 4),
            fixed_date=None,
            demanded_distribution=True,
            demanded_distribution_date=date(2023, 11, 30),
        ),
        # 같은 사람 · 같은 정보출처가 두 행 — 005의 UNIQUE (tenant_seq, source_kind)로는
        # 저장 자체가 안 되던 조합이다 (실측: 이것 때문에 명세서 467건을 잃었다)
        NoticeTenant(
            row_no=3,
            tenant_seq=1,
            tenant_name="홍길동",
            source_kind="등기사항전부증명서",
            occupied_part="207호",
            possession_basis="주거 주택임차권자",
            lease_period=None,
            deposit_amount=50_000_000,
            monthly_rent=None,
            move_in_date=date(2021, 6, 4),
            fixed_date=None,
            demanded_distribution=None,
            demanded_distribution_date=None,
        ),
    )
    notice = ItemNotice(
        court_office_code="B000210",
        case_no="2022타경101244",
        item_no="1",
        document_date=date(2026, 7, 3),
        baseline_raw=None,
        baseline_date=None,
        distribution_demand_deadline=None,
        assumed_rights_kind="NONE",
        risk_flags=[],
        lien_claim_amount=None,
        tenants=tenants,
    )

    first = repository.upsert_notices([notice])
    repository.upsert_notices([notice])
    # 같은 임차인의 세 행(정보출처 2종, 그중 하나는 중복)이 전부 저장되고 재실행해도 안 늘어난다
    assert first.failed == 0
    assert _tenant_rows(database_url) == 3

    # 기재사항만 재수집(tenants 비어 있음)해도 이미 받아둔 표를 지우지 않는다
    repository.upsert_notices([replace(notice, tenants=())])
    assert _tenant_rows(database_url) == 3


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_DB_TESTS") != "1",
    reason="set COLLECTOR_RUN_DB_TESTS=1 to run PostGIS integration tests",
)
def test_postgres_masks_tenant_names_only_for_ended_cases():
    """배당종결(015)된 사건만 성명을 지운다 (NF-03). 진행 중 사건은 건드리지 않는다."""
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")

    repository = PostgresAuctionRepository(database_url)
    run_migrations(database_url)
    _reset_or_skip(repository)
    page = parse_search_page(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    repository.upsert_items(page.items)

    def _notice_with_tenant(case_no: str) -> ItemNotice:
        return ItemNotice(
            court_office_code="B000210",
            case_no=case_no,
            item_no="1",
            document_date=date(2026, 7, 3),
            baseline_raw=None,
            baseline_date=None,
            distribution_demand_deadline=None,
            assumed_rights_kind=None,
            risk_flags=[],
            lien_claim_amount=None,
            tenants=(
                NoticeTenant(
                    row_no=1,
                    tenant_seq=1,
                    tenant_name="홍길동",
                    source_kind="권리신고",
                    occupied_part="101호",
                    possession_basis="주거 임차인",
                    lease_period=None,
                    deposit_amount=50_000_000,
                    monthly_rent=None,
                    move_in_date=date(2020, 1, 1),
                    fixed_date=None,
                    demanded_distribution=True,
                    demanded_distribution_date=None,
                ),
            ),
            tenants_scanned=True,
            # 성명이 그대로 들어 있는 보관 원문 — 마스킹이 이것도 지워야 한다 (017)
            tenant_text_region=(
                ({"text": "홍길동", "rect": [{"left": 30, "right": 60, "bottom": 460, "top": 470}]},),
            ),
            # 자유서술 3란까지 담긴 원본 — 마스킹이 이것도 지워야 한다 (019)
            pdf_bytes=b"%PDF-1.4 fake",
        )

    ended, open_case = "2022타경101244", "2023타경4722"
    repository.upsert_notices([_notice_with_tenant(ended), _notice_with_tenant(open_case)])
    assert repository.count_unmasked_tenant_names() == 2

    # 진행 중 사건에도 결과 행은 있다 — 종료 판정이 결과 유무가 아니라 015인지 확인한다
    repository.upsert_sale_results(
        [
            SaleResult(
                court_office_code="B000210",
                case_no=ended,
                item_no="1",
                dxdy_date=date(2026, 7, 16),
                dxdy_kind_code="01",
                result_code="015",  # 배당종결
                sale_amount=None,
                minimum_sale_price=None,
                failed_bid_count=None,
                source=SOURCE_CASE_SEARCH,
            ),
            SaleResult(
                court_office_code="B000210",
                case_no=open_case,
                item_no="1",
                dxdy_date=date(2026, 7, 22),
                dxdy_kind_code="01",
                result_code="002",  # 유찰 — 아직 진행 중
                sale_amount=None,
                minimum_sale_price=None,
                failed_bid_count=None,
                source=SOURCE_CASE_SEARCH,
            ),
        ]
    )

    assert repository.mask_ended_case_tenant_names() == 1
    assert repository.count_unmasked_tenant_names() == 1
    # 재실행해도 이미 지운 행을 다시 세지 않는다 (감사 로그가 부풀지 않아야 한다)
    assert repository.mask_ended_case_tenant_names() == 0

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT count(*) FROM auction_item_notice_tenant WHERE masked_at IS NOT NULL"
            )
            assert cur.fetchone()[0] == 1
            # 성명만 지우고 행·보증금·전입일은 남는다 — H3는 존재 여부를 쓴다
            cur.execute(
                "SELECT deposit_amount, move_in_date FROM auction_item_notice_tenant "
                "WHERE tenant_name IS NULL"
            )
            assert cur.fetchone() == (50_000_000, date(2020, 1, 1))
            # 보관 원문에도 성명이 있으므로 같이 지워야 한다 — 아니면 위 마스킹이 무의미하다 (017)
            cur.execute(
                "SELECT count(*) FROM auction_item_notice WHERE tenant_text_region IS NOT NULL"
            )
            assert cur.fetchone()[0] == 1  # 진행 중 사건 것만 남는다
            # PDF 원본도 마찬가지다. 여기엔 자유서술 3란의 제3자 실명까지 들어 있어
            # 남겨두면 006 의 결정과 NF-03 이 둘 다 무너진다 (019)
            cur.execute("SELECT count(*) FROM auction_item_notice WHERE pdf_bytes IS NOT NULL")
            assert cur.fetchone()[0] == 1


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_DB_TESTS") != "1",
    reason="set COLLECTOR_RUN_DB_TESTS=1 to run PostGIS integration tests",
)
def test_postgres_photo_upsert_is_idempotent_and_updates_changed_fields():
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")

    repository = PostgresAuctionRepository(database_url)
    run_migrations(database_url)
    _reset_or_skip(repository)
    page = parse_search_page(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    repository.upsert_items(page.items)

    # fixture 두 사건 모두 아직 사진이 없다 — 수집 대상
    assert len(repository.find_cases_missing_photos()) == 2
    assert repository.find_cases_missing_photos("B000299") == []

    photo_page = parse_photo_page(
        json.loads((Path(__file__).parent / "fixtures" / "court_photo_page.json").read_text(
            encoding="utf-8"
        )),
        court_office_code="B000210",
        case_no="2022타경101244",
    )

    first = repository.upsert_case_photos("B000210", "2022타경101244", photo_page.photos)
    second = repository.upsert_case_photos("B000210", "2022타경101244", photo_page.photos)
    # 설명이 바뀐 사진은 updated로 잡혀야 한다
    third = repository.upsert_case_photos(
        "B000210",
        "2022타경101244",
        [replace(photo_page.photos[0], caption="바뀐 설명"), *photo_page.photos[1:]],
    )

    assert (first.inserted, first.updated, first.skipped) == (3, 0, 0)
    assert (second.inserted, second.updated, second.skipped) == (0, 0, 3)
    assert (third.inserted, third.updated, third.skipped) == (0, 1, 2)

    # 사진이 채워진 사건은 더 이상 수집 대상이 아니다
    remaining = repository.find_cases_missing_photos()
    assert [row["case_no"] for row in remaining] == ["2023타경4722"]

    # DB에 없는 사건은 조용히 아무것도 하지 않는다
    unknown = repository.upsert_case_photos("B000210", "2024타경999999", photo_page.photos)
    # 저장은 하지 않되 건너뛴 장수를 센다 — _upsert_notice가 미수집 물건을 skipped로 세는 것과 같다.
    # 0으로 뭉개면 "우리가 추적하지 않는 사건의 사진을 받아왔다"는 신호가 로그에서 사라진다
    assert (unknown.inserted, unknown.updated, unknown.skipped) == (0, 0, len(photo_page.photos))

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT sum(byte_size), count(*) FROM auction_case_photo")
            total_bytes, rows = cur.fetchone()
    assert rows == 3
    assert int(total_bytes) == sum(len(p.image) for p in photo_page.photos)


def _tenant_rows(database_url: str) -> int:
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT count(*) FROM auction_item_notice_tenant")
            return int(cur.fetchone()[0])


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_DB_TESTS") != "1",
    reason="set COLLECTOR_RUN_DB_TESTS=1 to run PostGIS integration tests",
)
def test_postgres_notice_scan_saves_when_pdf_is_missing():
    """PDF를 못 받은 회차도 스캔 결과를 저장한다.

    실측(2026-08-21~31): 이 경로가 열흘간 20,518건 실패했다. 원인은
    `pdf_fetched_at = CASE WHEN %s IS NULL ...`에서 PostgreSQL이 파라미터 타입을 추론하지
    못한 것(`could not determine data type of parameter $6`)이다. COALESCE 자리는 컬럼과
    비교되어 추론되지만 `IS NULL`은 단독이라 안 된다.

    기존 테스트는 pdf_bytes에 값이 **있는** 경우만 봐서 이걸 놓쳤다. 실전에서는 열람 창 밖이라
    PDF를 못 받는 쪽이 압도적으로 많다.
    """
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")

    repository = PostgresAuctionRepository(database_url)
    run_migrations(database_url)
    _reset_or_skip(repository)
    page = parse_search_page(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    repository.upsert_items(page.items)

    notice = ItemNotice(
        court_office_code="B000210",
        case_no="2023타경4722",
        item_no="1",
        document_date=date(2026, 7, 3),
        baseline_raw=None,
        baseline_date=None,
        distribution_demand_deadline=None,
        assumed_rights_kind=None,
        risk_flags=[],
        lien_claim_amount=None,
        tenants=(),
        tenants_scanned=True,
        pdf_bytes=None,  # PDF를 못 받은 회차
    )

    result = repository.upsert_notices([notice])

    assert result.inserted + result.updated == 1
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT n.tenant_scanned_at, n.pdf_fetched_at
                FROM auction_item_notice n
                JOIN auction_item ai ON ai.id = n.auction_item_id
                JOIN auction_case ac ON ac.id = ai.auction_case_id
                WHERE ac.case_no = '2023타경4722' AND ai.item_no = '1'
                """
            )
            row = cur.fetchone()
    assert row is not None
    # 스캔 시각은 남는다 — "열었더니 없더라"와 "아직 못 열었다"를 가르는 기록이다
    assert row[0] is not None
    # PDF를 못 받았으므로 받은 시각은 비어 있어야 한다
    assert row[1] is None


@pytest.mark.skipif(
    os.getenv("COLLECTOR_RUN_DB_TESTS") != "1",
    reason="set COLLECTOR_RUN_DB_TESTS=1 to run PostGIS integration tests",
)
def test_postgres_rescan_skips_notices_whose_bid_date_has_passed():
    """기일이 지난 명세서는 재수집 대상에서 뺀다.

    명세서 열람 창은 기일 1주 전부터 기일까지다(WP-11 §4-3). 창이 닫힌 물건은 상세조회가
    빈 객체로 와서 받아도 얻는 게 없는데, 회차당 상한을 그만큼 잡아먹어 **아직 창이 열려
    있는 물건이 순서를 못 받는다.**

    실측(2026-08-31): 재수집 대상 4,246건 중 3,301건(78%)이 기일이 지난 물건이었다.
    그날 기일이 남은 건 731건뿐인데 상한 40으로는 손도 못 대는 상태였다.
    """
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        pytest.skip("DATABASE_URL is required")

    repository = PostgresAuctionRepository(database_url)
    run_migrations(database_url)
    _reset_or_skip(repository)
    page = parse_search_page(json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))
    repository.upsert_items(page.items)

    def _scanned(case_no: str, bid_date: date | None) -> ItemNotice:
        return ItemNotice(
            court_office_code="B000210",
            case_no=case_no,
            item_no="1",
            document_date=date(2026, 7, 3),
            bid_date=bid_date,
            baseline_raw=None,
            baseline_date=None,
            distribution_demand_deadline=None,
            assumed_rights_kind=None,
            risk_flags=[],
            lien_claim_amount=None,
            tenants=(),
            tenants_scanned=True,
            tenant_source="TEXT_LAYER",  # PDF로 못 읽어서 재수집 후보다
        )

    past, upcoming = "2022타경101244", "2023타경4722"
    repository.upsert_notices(
        [_scanned(past, date(2020, 1, 1)), _scanned(upcoming, date(2099, 1, 1))]
    )
    # 20시간 조건을 통과시킨다 — 방금 넣은 행이라 그대로면 둘 다 안 나온다
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE auction_item_notice SET tenant_scanned_at = now() - interval '2 days'"
            )
            conn.commit()

    keys = repository.find_item_keys_needing_pdf_rescan()
    case_numbers = {case_no for _, case_no, _, _ in keys}

    assert upcoming in case_numbers
    assert past not in case_numbers
