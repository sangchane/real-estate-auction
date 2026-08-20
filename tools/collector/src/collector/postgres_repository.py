from __future__ import annotations

import logging
from datetime import date
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from collector.court_parser import AuctionItem, CasePhoto, ItemNotice, SaleResult
from collector.repository import UpsertResult

logger = logging.getLogger(__name__)


MIGRATIONS_DIR = Path(__file__).parents[2] / "migrations"


class PostgresAuctionRepository:
    def __init__(self, database_url: str) -> None:
        if not database_url:
            raise ValueError("database_url is required")
        self._database_url = database_url

    def upsert_items(self, items: list[AuctionItem]) -> UpsertResult:
        inserted = 0
        updated = 0
        skipped = 0

        with psycopg.connect(self._database_url) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                for item in items:
                    case_id = _upsert_case(cur, item)
                    item_result = _upsert_item(cur, case_id, item)
                    auction_item_id = int(item_result["id"])

                    if item_result["change_state"] == "inserted":
                        inserted += 1
                    elif item_result["change_state"] == "updated":
                        updated += 1
                    else:
                        skipped += 1

                    _insert_schedule_snapshot(cur, auction_item_id, item)
                    _insert_raw_snapshot(cur, auction_item_id, item)

        return UpsertResult(inserted=inserted, updated=updated, skipped=skipped)

    def upsert_sale_results(self, results: list[SaleResult]) -> UpsertResult:
        """기일 결과 관측값을 멱등 저장한다 — 같은 관측 튜플은 재실행해도 늘지 않는다."""
        inserted = 0
        skipped = 0

        with psycopg.connect(self._database_url) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                for result in results:
                    if _insert_sale_result(cur, result):
                        inserted += 1
                    else:
                        skipped += 1

        return UpsertResult(inserted=inserted, updated=0, skipped=skipped)

    def upsert_notices(self, notices: list[ItemNotice]) -> UpsertResult:
        """매각물건명세서 기재사항을 멱등 저장한다 — 같은 물건·작성일은 재실행해도 늘지 않는다.

        명세서 한 건이 실패해도 나머지는 저장한다. 한 배치는 물건 수백 건이고 그걸 모으는 데
        수천 요청·한 시간이 든다 — 실측(2026-07-31): 중복키 한 건이 배치 전체를 되돌려
        467건을 통째로 잃었다. 그래서 건마다 savepoint를 잡는다.
        """
        inserted = 0
        updated = 0
        skipped = 0
        failed = 0

        with psycopg.connect(self._database_url) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                for notice in notices:
                    try:
                        with conn.transaction():  # 중첩이라 savepoint — 이 건만 되돌린다
                            state = _upsert_notice(cur, notice)
                    except psycopg.Error as exc:
                        failed += 1
                        logger.warning(
                            "notice_upsert_failed court=%s case=%s item=%s error=%s",
                            notice.court_office_code,
                            notice.case_no,
                            notice.item_no,
                            exc,
                        )
                        continue
                    if state == "inserted":
                        inserted += 1
                    elif state == "updated":
                        updated += 1
                    else:
                        skipped += 1

        return UpsertResult(inserted=inserted, updated=updated, skipped=skipped, failed=failed)

    def find_items_pending_sale_result(self) -> list[dict[str, Any]]:
        """매각기일이 지났는데 그 기일 이후 결과 행이 없는 물건 목록 — backfill 대상."""
        with psycopg.connect(self._database_url) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT ac.court_office_code, ac.case_no, ai.item_no
                    FROM auction_item ai
                    JOIN auction_case ac ON ac.id = ai.auction_case_id
                    JOIN LATERAL (
                      SELECT max(s.bid_datetime) AS latest_bid
                      FROM auction_schedule s
                      WHERE s.auction_item_id = ai.id AND s.bid_datetime IS NOT NULL
                    ) sched ON sched.latest_bid IS NOT NULL
                    WHERE sched.latest_bid < now()
                      AND NOT EXISTS (
                        SELECT 1
                        FROM auction_sale_result r
                        WHERE r.auction_item_id = ai.id
                          AND r.dxdy_date >= (sched.latest_bid AT TIME ZONE 'Asia/Seoul')::date
                      )
                    ORDER BY ac.court_office_code, ac.case_no, ai.item_no
                    """
                )
                return list(cur.fetchall())

    def find_item_keys_with_notice(self) -> set[tuple[str, str, str, date | None]]:
        """명세서를 가진 (물건, 그 명세서의 기일) 집합 — daily가 상세조회를 건너뛰는 데 쓴다.

        기일까지 키에 넣는 이유: 명세서는 기일마다 새로 작성되므로, 유찰 후 새 기일을 받은 물건은
        명세서를 갖고 있어도 **그 기일 것은 없다**. 물건 단위로만 보면 영영 못 받는다 (§4-13).
        """
        with psycopg.connect(self._database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT ac.court_office_code, ac.case_no, ai.item_no, n.bid_date
                    FROM auction_item_notice n
                    JOIN auction_item ai ON ai.id = n.auction_item_id
                    JOIN auction_case ac ON ac.id = ai.auction_case_id
                    """
                )
                return {(str(r[0]), str(r[1]), str(r[2]), r[3]) for r in cur.fetchall()}

    def find_item_keys_with_tenant_scan(self) -> set[tuple[str, str, str, date | None]]:
        """점유자 표 파싱까지 끝낸 (물건, 기일) 집합 — daily가 PDF를 다시 열지 결정하는 데 쓴다.

        표가 비어 있어도(임차인 없는 물건) 여기 포함된다. 기재사항만 받아둔 물건, 그리고 기일이
        바뀌어 이번 기일 표를 아직 못 받은 물건은 빠지므로 열람 창 안에서 다시 열린다.
        """
        with psycopg.connect(self._database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT ac.court_office_code, ac.case_no, ai.item_no, n.bid_date
                    FROM auction_item_notice n
                    JOIN auction_item ai ON ai.id = n.auction_item_id
                    JOIN auction_case ac ON ac.id = ai.auction_case_id
                    WHERE n.tenant_scanned_at IS NOT NULL
                    """
                )
                return {(str(r[0]), str(r[1]), str(r[2]), r[3]) for r in cur.fetchall()}

    def mask_ended_case_tenant_names(self) -> int:
        """배당종결된 사건의 점유자 성명을 지우고 지운 행 수를 돌려준다 (NF-03).

        종료 판정은 결과코드 015(배당종결)다. 사건이 종국되면 법원 조회 자체가 막히므로(§1-4)
        015를 본 시점이 우리가 종료를 확인할 수 있는 마지막 신호다.

        성명은 부분 마스킹(홍OO) 대신 **통째로 지운다**. 정규식 기반 한국어 이름 처리는 이 프로젝트에서
        양방향으로 실패한 전력이 있고(§4-4), 여기서는 컬럼 전체가 성명이라 부분을 남길 이유가 없다.
        행 자체는 남으므로 "임차인이 있었다"는 사실과 tenant_seq(동일인 묶음)는 보존된다 —
        H3는 존재 여부만 쓰고 신원은 쓰지 않는다.

        UPDATE 한 문장으로 처리한다. 조회와 쓰기를 나누면 그 사이에 들어온 행을 놓치고,
        감사 로그의 건수가 실제 쓰기와 어긋날 수 있다.
        """
        with psycopg.connect(self._database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE auction_item_notice_tenant t
                    SET tenant_name = NULL, masked_at = now()
                    FROM auction_item_notice n
                    JOIN auction_item ai ON ai.id = n.auction_item_id
                    WHERE t.notice_id = n.id
                      AND t.tenant_name IS NOT NULL
                      AND EXISTS (
                        SELECT 1 FROM auction_sale_result r
                        WHERE r.auction_item_id = ai.id AND r.result_code = '015'
                      )
                    """
                )
                masked = cur.rowcount
                # 보관해 둔 표 원문에도 성명이 그대로 들어 있다 — 같은 시점에 지우지 않으면
                # 위 마스킹이 무의미해진다 (017, NF-03)
                cur.execute(
                    """
                    UPDATE auction_item_notice n
                    SET tenant_text_region = NULL
                    FROM auction_item ai
                    WHERE ai.id = n.auction_item_id
                      AND n.tenant_text_region IS NOT NULL
                      AND EXISTS (
                        SELECT 1 FROM auction_sale_result r
                        WHERE r.auction_item_id = ai.id AND r.result_code = '015'
                      )
                    """
                )
                return masked

    def count_unmasked_tenant_names(self) -> int:
        """아직 성명이 남아 있는 점유자 행 수 — 감사용."""
        with psycopg.connect(self._database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT count(*) FROM auction_item_notice_tenant WHERE tenant_name IS NOT NULL"
                )
                return int(cur.fetchone()[0])

    def find_cases_missing_photos(
        self, court_office_code: str | None = None
    ) -> list[dict[str, Any]]:
        """물건은 있는데 사진이 한 장도 없는 사건 목록 — photos 수집 대상 (사건당 요청 1회)."""
        with psycopg.connect(self._database_url) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT DISTINCT ac.court_office_code, ac.case_no
                    FROM auction_case ac
                    JOIN auction_item ai ON ai.auction_case_id = ac.id
                    WHERE (%s::text IS NULL OR ac.court_office_code = %s)
                      AND NOT EXISTS (
                        SELECT 1 FROM auction_case_photo p WHERE p.auction_case_id = ac.id
                      )
                    ORDER BY ac.court_office_code, ac.case_no
                    """,
                    (court_office_code, court_office_code),
                )
                return list(cur.fetchall())

    def upsert_case_photos(
        self, court_office_code: str, case_no: str, photos: list[CasePhoto]
    ) -> UpsertResult:
        """사건 사진을 **사건 단위로** 멱등 저장한다.

        법원 사진 API는 사건 단위이고 메타에 물건번호가 없다. 물건마다 복제 저장하면
        다물건 사건이 배로 커진다(실측: 2사건 11물건 419행 52MB vs 고유 50장 7.5MB).
        화면에서는 물건 → 사건으로 조인해 보여준다.
        바이트 비교는 무거워 크기·URL·설명·형식이 같으면 건너뛴다.
        """
        inserted = 0
        updated = 0
        skipped = 0

        with psycopg.connect(self._database_url) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    "SELECT id FROM auction_case WHERE court_office_code = %s AND case_no = %s",
                    (court_office_code, case_no),
                )
                row = cur.fetchone()
                if row is None:
                    return UpsertResult(inserted=0, updated=0, skipped=len(photos))
                case_id = int(row["id"])
                for photo in photos:
                    state = _upsert_photo(cur, case_id, photo)
                    if state == "inserted":
                        inserted += 1
                    elif state == "updated":
                        updated += 1
                    else:
                        skipped += 1

        return UpsertResult(inserted=inserted, updated=updated, skipped=skipped)

    def find_items_in_bbox(
        self,
        *,
        min_lng: float,
        min_lat: float,
        max_lng: float,
        max_lat: float,
    ) -> list[dict[str, Any]]:
        with psycopg.connect(self._database_url) as conn:
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute(
                    """
                    SELECT ac.court_office_code, ac.case_no, ai.item_no
                    FROM auction_item ai
                    JOIN auction_case ac ON ac.id = ai.auction_case_id
                    WHERE ai.geom IS NOT NULL
                      AND ST_Intersects(
                        ai.geom,
                        ST_MakeEnvelope(%s, %s, %s, %s, 4326)
                      )
                    ORDER BY ac.court_office_code, ac.case_no, ai.item_no
                    """,
                    (min_lng, min_lat, max_lng, max_lat),
                )
                return list(cur.fetchall())

    def truncate_for_test(self) -> None:
        """수집 테이블을 전부 비운다 — 이름이 `_test`로 끝나는 DB에서만 동작한다.

        CASCADE가 auction_case에서 명세서·점유자 표·매각결과·사진까지 전부 지운다. 그중
        **명세서와 점유자 표는 다시 못 받는다** — 기일이 지난 물건은 물건상세가 빈 객체로 오기
        때문이다(WP-11 §4-3). 실제로 2026-07-31에 이 함수가 개발 DB의 수집분을 날렸다.

        "데이터가 있으면 거부"로는 못 막는다 — 수집 1단계처럼 테이블이 잠깐 비는 구간이 있어
        그때 통과해버린다(실측). DB 이름으로 가르는 게 유일하게 확실한 경계다.
        """
        with psycopg.connect(self._database_url) as conn:
            dbname = conn.info.dbname
            if not dbname.endswith("_test"):
                raise RuntimeError(
                    f"truncate_for_test refused on database {dbname!r}: "
                    "이름이 '_test'로 끝나는 DB에서만 허용한다 (WP-11 §4-3)."
                )
            with conn.cursor() as cur:
                cur.execute(
                    """
                    TRUNCATE case_person, auction_item_raw, auction_schedule, auction_item,
                      auction_case
                    RESTART IDENTITY CASCADE
                    """
                )


def run_migrations(database_url: str) -> None:
    if not database_url:
        raise ValueError("database_url is required")

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            for migration_path in sorted(MIGRATIONS_DIR.glob("*.sql")):
                cur.execute(migration_path.read_text(encoding="utf-8"))


def _upsert_case(cur: psycopg.Cursor[Any], item: AuctionItem) -> int:
    cur.execute(
        """
        INSERT INTO auction_case (court_office_code, case_no, court_name)
        VALUES (%s, %s, %s)
        ON CONFLICT (court_office_code, case_no)
        DO UPDATE SET
          court_name = EXCLUDED.court_name,
          updated_at = now()
        RETURNING id
        """,
        (item.court_office_code, item.case_no, item.court_name),
    )
    row = cur.fetchone()
    if row is None:
        raise RuntimeError("auction_case upsert returned no row")
    return int(row["id"])


def _upsert_item(cur: psycopg.Cursor[Any], case_id: int, item: AuctionItem) -> dict[str, Any]:
    lng_lat = item.location
    cur.execute(
        """
        WITH existing AS (
          SELECT *
          FROM auction_item
          WHERE auction_case_id = %s AND item_no = %s
        ),
        upserted AS (
          INSERT INTO auction_item (
            auction_case_id,
            item_no,
            usage_code,
            address,
            appraisal_amount,
            minimum_sale_price,
            failed_bid_count,
            geom
          )
          VALUES (
            %s,
            %s,
            %s,
            %s,
            %s,
            %s,
            %s,
            CASE
              WHEN %s::double precision IS NULL OR %s::double precision IS NULL THEN NULL
              ELSE ST_SetSRID(ST_MakePoint(%s, %s), 4326)
            END
          )
          ON CONFLICT (auction_case_id, item_no)
          DO UPDATE SET
            usage_code = EXCLUDED.usage_code,
            address = EXCLUDED.address,
            appraisal_amount = EXCLUDED.appraisal_amount,
            minimum_sale_price = EXCLUDED.minimum_sale_price,
            failed_bid_count = EXCLUDED.failed_bid_count,
            geom = EXCLUDED.geom,
            updated_at = CASE
              WHEN auction_item.usage_code IS DISTINCT FROM EXCLUDED.usage_code
                OR auction_item.address IS DISTINCT FROM EXCLUDED.address
                OR auction_item.appraisal_amount IS DISTINCT FROM EXCLUDED.appraisal_amount
                OR auction_item.minimum_sale_price IS DISTINCT FROM EXCLUDED.minimum_sale_price
                OR auction_item.failed_bid_count IS DISTINCT FROM EXCLUDED.failed_bid_count
                OR auction_item.geom IS DISTINCT FROM EXCLUDED.geom
              THEN now()
              ELSE auction_item.updated_at
            END
          RETURNING id
        )
        SELECT
          upserted.id,
          CASE
            WHEN NOT EXISTS (SELECT 1 FROM existing) THEN 'inserted'
            WHEN EXISTS (
              SELECT 1
              FROM existing
              WHERE existing.usage_code IS DISTINCT FROM %s
                OR existing.address IS DISTINCT FROM %s
                OR existing.appraisal_amount IS DISTINCT FROM %s
                OR existing.minimum_sale_price IS DISTINCT FROM %s
                OR existing.failed_bid_count IS DISTINCT FROM %s
            ) THEN 'updated'
            ELSE 'skipped'
          END AS change_state
        FROM upserted
        """,
        (
            case_id,
            item.item_no,
            case_id,
            item.item_no,
            item.usage_code,
            item.address,
            item.appraisal_amount,
            item.minimum_sale_price,
            item.failed_bid_count,
            lng_lat[0] if lng_lat else None,
            lng_lat[1] if lng_lat else None,
            lng_lat[0] if lng_lat else None,
            lng_lat[1] if lng_lat else None,
            item.usage_code,
            item.address,
            item.appraisal_amount,
            item.minimum_sale_price,
            item.failed_bid_count,
        ),
    )
    row = cur.fetchone()
    if row is None:
        raise RuntimeError("auction_item upsert returned no row")
    return dict(row)


def _insert_sale_result(cur: psycopg.Cursor[Any], result: SaleResult) -> bool:
    """자연키로 물건을 찾아 결과 행을 넣는다. 물건이 없거나 이미 같은 관측이 있으면 넣지 않는다.

    UNIQUE 제약(auction_item_id, dxdy_date, dxdy_kind_code, result_code, sale_amount)은
    NULL 낙찰가(유찰 등)를 서로 다른 값으로 취급해 중복을 막지 못하므로,
    IS NOT DISTINCT FROM으로 직접 중복 검사를 한 뒤 ON CONFLICT DO NOTHING을 겸용한다.
    """
    cur.execute(
        """
        INSERT INTO auction_sale_result (
          auction_item_id,
          dxdy_date,
          dxdy_kind_code,
          result_code,
          sale_amount,
          minimum_sale_price,
          failed_bid_count,
          source
        )
        SELECT ai.id, %s, %s, %s, %s, %s, %s, %s
        FROM auction_item ai
        JOIN auction_case ac ON ac.id = ai.auction_case_id
        WHERE ac.court_office_code = %s
          AND ac.case_no = %s
          AND ai.item_no = %s
          AND NOT EXISTS (
            SELECT 1
            FROM auction_sale_result r
            WHERE r.auction_item_id = ai.id
              AND r.dxdy_date = %s
              AND r.dxdy_kind_code = %s
              AND r.result_code IS NOT DISTINCT FROM %s
              AND r.sale_amount IS NOT DISTINCT FROM %s
          )
        ON CONFLICT DO NOTHING
        """,
        (
            result.dxdy_date,
            result.dxdy_kind_code,
            result.result_code,
            result.sale_amount,
            result.minimum_sale_price,
            result.failed_bid_count,
            result.source,
            result.court_office_code,
            result.case_no,
            result.item_no,
            result.dxdy_date,
            result.dxdy_kind_code,
            result.result_code,
            result.sale_amount,
        ),
    )
    return cur.rowcount > 0


# risk_flags(TEXT[])는 psycopg가 Python list로 왕복 변환하므로 아래 변경 검사도
# SQL이 아닌 Python에서 리스트 동등 비교로 한다 — 배열 NULL/순서 문제를 피한다(항상 정렬 저장).
_NOTICE_FIELDS = (
    "bid_date",
    "baseline_raw",
    "baseline_date",
    "distribution_demand_deadline",
    "assumed_rights_kind",
    "risk_flags",
    "lien_claim_amount",
)


_TENANT_FIELDS = (
    "row_no",
    "tenant_seq",
    "tenant_name",
    "source_kind",
    "occupied_part",
    "possession_basis",
    "lease_period",
    "deposit_amount",
    "monthly_rent",
    "move_in_date",
    "fixed_date",
    "demanded_distribution",
    "demanded_distribution_date",
    "demanded_distribution_raw",
    "deposit_tranches",
)


def _tenant_value(tenant: Any, field: str) -> Any:
    """점유자 한 칸의 저장값. 보증금 몫만 JSONB로 바꾸고 나머지는 그대로 넘긴다."""
    value = getattr(tenant, field)
    if field != "deposit_tranches" or value is None:
        return value
    return Jsonb(
        [
            {
                "amount": tranche.amount,
                "fixedDate": tranche.fixed_date.isoformat() if tranche.fixed_date else None,
            }
            for tranche in value
        ]
    )


def _upsert_notice(cur: psycopg.Cursor[Any], notice: ItemNotice) -> str:
    """명세서 한 건을 저장하고 inserted/updated/skipped를 돌려준다.

    UNIQUE (auction_item_id, document_date)는 PostgreSQL이 NULL을 서로 다른 값으로 취급해
    작성일 없는 행의 중복을 막지 못하므로, IS NOT DISTINCT FROM으로 직접 기존 행을 찾는다.
    """
    cur.execute(
        """
        SELECT ai.id
        FROM auction_item ai
        JOIN auction_case ac ON ac.id = ai.auction_case_id
        WHERE ac.court_office_code = %s AND ac.case_no = %s AND ai.item_no = %s
        """,
        (notice.court_office_code, notice.case_no, notice.item_no),
    )
    item_row = cur.fetchone()
    if item_row is None:
        return "skipped"  # 아직 수집되지 않은 물건 — 조용히 건너뛴다
    auction_item_id = int(item_row["id"])

    values = tuple(getattr(notice, field) for field in _NOTICE_FIELDS)
    cur.execute(
        f"""
        SELECT id, {", ".join(_NOTICE_FIELDS)}
        FROM auction_item_notice
        WHERE auction_item_id = %s AND document_date IS NOT DISTINCT FROM %s
        """,
        (auction_item_id, notice.document_date),
    )
    existing = cur.fetchone()

    if existing is None:
        cur.execute(
            f"""
            INSERT INTO auction_item_notice (
              auction_item_id, document_date, {", ".join(_NOTICE_FIELDS)}
            )
            VALUES (%s, %s, {", ".join(["%s"] * len(_NOTICE_FIELDS))})
            RETURNING id
            """,
            (auction_item_id, notice.document_date, *values),
        )
        _replace_notice_tenants(cur, int(cur.fetchone()["id"]), notice)
        return "inserted"

    _replace_notice_tenants(cur, int(existing["id"]), notice)

    if all(existing[field] == value for field, value in zip(_NOTICE_FIELDS, values, strict=True)):
        return "skipped"

    cur.execute(
        f"""
        UPDATE auction_item_notice
        SET {", ".join(f"{field} = %s" for field in _NOTICE_FIELDS)}, observed_at = now()
        WHERE id = %s
        """,
        (*values, int(existing["id"])),
    )
    return "updated"


def _text_region_json(region: tuple[tuple[Any, ...], ...] | None) -> Jsonb | None:
    """표 영역 원문을 JSONB 값으로 감싼다. 빈 값은 NULL로 둔다 — "못 열었다"와 같게 읽는다."""
    return Jsonb([list(page) for page in region]) if region else None


def _replace_notice_tenants(cur: psycopg.Cursor[Any], notice_id: int, notice: ItemNotice) -> None:
    """점유자 표를 통째로 다시 쓰고 스캔 시각을 남긴다 — 같은 문서를 재파싱해도 행이 늘지 않게 한다.

    tenants가 비어 있으면 표는 손대지 않는다. PDF 열람 창 밖에서 기재사항만 재수집할 때
    이미 받아둔 점유자 표를 지우면 안 된다 (표는 열람 창 안에서만 얻을 수 있다).

    스캔 시각은 표가 비어 있어도 남긴다 — 그게 "열었더니 임차인이 없더라"와 "아직 못 열었다"를
    가르는 유일한 기록이고, daily가 PDF를 다시 열지 여기서 판단한다.
    """
    if notice.tenants_scanned:
        # 버린 행 수도 함께 남긴다 (013, WP-11 §4-7) — 표가 비어도 이 값이 >0이면
        # "임차인 없음"이 아니라 "행이 있었는데 버림"이라서 H3 표본에서 빼야 한다
        cur.execute(
            """
            UPDATE auction_item_notice
            SET tenant_scanned_at = now(),
                tenant_rows_rejected = %s,
                tenant_table_continued = %s,
                -- 빈 값으로 덮지 않는다. 문서는 열렸는데 표를 못 찾은 회차(쪽 상한·양식 변형)가
                -- 이미 보관한 원문을 지우면 열람 창이 닫힌 뒤에는 복구할 수 없다 —
                -- 바로 아래 tenants가 비면 표를 손대지 않는 것과 같은 이유다
                tenant_text_region = COALESCE(%s, tenant_text_region),
                tenant_source = COALESCE(%s, tenant_source)
            WHERE id = %s
            """,
            (
                notice.tenants_rejected,
                notice.tenants_continued,
                _text_region_json(notice.tenant_text_region),
                notice.tenant_source,
                notice_id,
            ),
        )

    if not notice.tenants:
        return

    cur.execute("DELETE FROM auction_item_notice_tenant WHERE notice_id = %s", (notice_id,))
    for tenant in notice.tenants:
        cur.execute(
            f"""
            INSERT INTO auction_item_notice_tenant (notice_id, {", ".join(_TENANT_FIELDS)})
            VALUES (%s, {", ".join(["%s"] * len(_TENANT_FIELDS))})
            """,
            (notice_id, *(_tenant_value(tenant, field) for field in _TENANT_FIELDS)),
        )


def _upsert_photo(cur: psycopg.Cursor[Any], auction_case_id: int, photo: CasePhoto) -> str:
    """사진 한 장을 저장하고 inserted/updated/skipped를 돌려준다."""
    cur.execute(
        """
        SELECT id, url, caption, content_type, byte_size
        FROM auction_case_photo
        WHERE auction_case_id = %s AND source = %s AND seq = %s
        """,
        (auction_case_id, photo.source, photo.seq),
    )
    existing = cur.fetchone()

    if existing is not None and (
        existing["url"] == photo.url
        and existing["caption"] == photo.caption
        and existing["content_type"] == photo.content_type
        and existing["byte_size"] == len(photo.image)
    ):
        return "skipped"

    cur.execute(
        """
        INSERT INTO auction_case_photo (
          auction_case_id, source, seq, category_code, category_name,
          url, caption, content_type, bytes, byte_size
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (auction_case_id, source, seq)
        DO UPDATE SET
          url = EXCLUDED.url,
          caption = EXCLUDED.caption,
          content_type = EXCLUDED.content_type,
          bytes = EXCLUDED.bytes,
          byte_size = EXCLUDED.byte_size,
          observed_at = now()
        """,
        (
            auction_case_id,
            photo.source,
            photo.seq,
            photo.category_code,
            photo.category_name,
            photo.url,
            photo.caption,
            photo.content_type,
            photo.image,
            len(photo.image),
        ),
    )
    return "inserted" if existing is None else "updated"


def _insert_schedule_snapshot(cur: psycopg.Cursor[Any], auction_item_id: int, item: AuctionItem) -> None:
    cur.execute(
        """
        INSERT INTO auction_schedule (
          auction_item_id,
          bid_datetime,
          minimum_sale_price,
          failed_bid_count
        )
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (auction_item_id, bid_datetime, minimum_sale_price, failed_bid_count)
        DO NOTHING
        """,
        (auction_item_id, item.bid_datetime, item.minimum_sale_price, item.failed_bid_count),
    )


def _insert_raw_snapshot(cur: psycopg.Cursor[Any], auction_item_id: int, item: AuctionItem) -> None:
    cur.execute(
        """
        INSERT INTO auction_item_raw (auction_item_id, source, payload)
        VALUES (%s, %s, %s)
        """,
        (auction_item_id, "courtauction.search", Jsonb(item.raw)),
    )
