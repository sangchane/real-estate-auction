# 물건 좌표를 법정동·정비구역 경계에 공간조인해 `auction_item_dong`·`auction_item_zone`에 사전계산한다.
from __future__ import annotations

import argparse
import logging
from dataclasses import dataclass

import psycopg

from collector.config import load_config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DongJoinResult:
    total: int
    joined: int
    unmatched: int
    removed: int


@dataclass(frozen=True)
class ZoneJoinResult:
    items: int
    zones: int
    pairs: int
    removed: int


# 포함 기준은 ST_Contains다 — 경계선 위 물건은 어느 동에도 붙지 않는다. 동은 배타적 분할이라
# ST_Intersects(경계 포함)를 쓰면 한 물건이 두 동에 속해 auction_item_dong의 PK(물건 하나)와
# 모순된다 (04-architecture FR-017). 미배정 물건은 행을 만들지 않고 건수만 남긴다.
# 물건은 읽기만 하므로 3시간마다 도는 수집 배치의 auction_item 쓰기를 막지 않는다.
_UPSERT_SQL = """
INSERT INTO auction_item_dong (auction_item_id, bjd_code, computed_at)
SELECT item.id, dong.bjd_code, now()
FROM auction_item AS item
JOIN bjd_dong AS dong ON ST_Contains(dong.geom, item.geom)
WHERE item.geom IS NOT NULL
ON CONFLICT (auction_item_id) DO UPDATE SET
    bjd_code = EXCLUDED.bjd_code,
    computed_at = EXCLUDED.computed_at
"""

# 좌표가 고쳐져 서울 밖으로 나가거나 동 경계가 바뀌어 이제 아무 동에도 안 붙는 물건의 옛 행을
# 지운다. 남겨 두면 화면이 옛 동의 노후도를 계속 사실로 말한다.
_DELETE_ORPHAN_SQL = """
DELETE FROM auction_item_dong AS link
WHERE NOT EXISTS (
    SELECT 1
    FROM auction_item AS item
    JOIN bjd_dong AS dong ON ST_Contains(dong.geom, item.geom)
    WHERE item.id = link.auction_item_id
)
"""

_TOTAL_SQL = "SELECT count(*) FROM auction_item WHERE geom IS NOT NULL"


def recompute_dong(conn: psycopg.Connection) -> DongJoinResult:
    """좌표가 있는 전 물건의 법정동을 다시 계산한다. 커밋은 호출자가 한다.

    연결을 받는 이유는 폴리곤 적재 직후 물건×구역 조인과 한 트랜잭션으로 묶기 위해서다
    (04-architecture 데이터 흐름 1).
    """
    with conn.cursor() as cur:
        total = cur.execute(_TOTAL_SQL).fetchone()[0]
        cur.execute(_UPSERT_SQL)
        joined = cur.rowcount
        cur.execute(_DELETE_ORPHAN_SQL)
        removed = cur.rowcount

    result = DongJoinResult(
        total=total,
        joined=joined,
        unmatched=total - joined,
        removed=removed,
    )
    logger.info(
        "dong_join_done total=%s joined=%s unmatched=%s removed=%s",
        result.total,
        result.joined,
        result.unmatched,
        result.removed,
    )
    return result


# 포함 기준은 ST_Intersects다 — 법정동(ST_Contains)과 일부러 다르다. 구역은 배타적 분할이
# 아니라 실제로 겹치므로 한 물건이 여러 구역에 붙는 것이 정상이고(엣지 A-1), 경계선 위 물건을
# 빼면 구역 안 물건을 놓친다(엣지 A-3). geom이 NULL인 구역(폴리곤 없는 대상지)은 ST_Intersects가
# NULL을 돌려주어 자연히 빠진다.
_ZONE_UPSERT_SQL = """
INSERT INTO auction_item_zone (auction_item_id, zone_id, computed_at)
SELECT item.id, zone.id, now()
FROM auction_item AS item
JOIN redevelopment_zone AS zone ON ST_Intersects(zone.geom, item.geom)
WHERE item.geom IS NOT NULL
ON CONFLICT (auction_item_id, zone_id) DO UPDATE SET
    computed_at = EXCLUDED.computed_at
"""

# 구역 경계가 줄거나 물건 좌표가 고쳐져 이제 겹치지 않는 짝을 지운다. 조인은 파생물이라
# 재계산이 곧 복구다 (07 오염 복구 ④) — 남겨 두면 화면이 옛 구역을 계속 사실로 말한다.
_ZONE_DELETE_ORPHAN_SQL = """
DELETE FROM auction_item_zone AS link
WHERE NOT EXISTS (
    SELECT 1
    FROM auction_item AS item
    JOIN redevelopment_zone AS zone ON ST_Intersects(zone.geom, item.geom)
    WHERE item.id = link.auction_item_id
      AND zone.id = link.zone_id
)
"""

_ZONE_TOTAL_SQL = "SELECT count(*) FROM redevelopment_zone WHERE geom IS NOT NULL"


def recompute_zone(conn: psycopg.Connection) -> ZoneJoinResult:
    """좌표가 있는 전 물건의 정비구역 겹침을 다시 계산한다. 커밋은 호출자가 한다."""
    with conn.cursor() as cur:
        items = cur.execute(_TOTAL_SQL).fetchone()[0]
        zones = cur.execute(_ZONE_TOTAL_SQL).fetchone()[0]
        cur.execute(_ZONE_UPSERT_SQL)
        pairs = cur.rowcount
        cur.execute(_ZONE_DELETE_ORPHAN_SQL)
        removed = cur.rowcount

    result = ZoneJoinResult(items=items, zones=zones, pairs=pairs, removed=removed)
    logger.info(
        "zone_join_done items=%s zones=%s pairs=%s removed=%s",
        result.items,
        result.zones,
        result.pairs,
        result.removed,
    )
    return result


def main(argv: list[str] | None = None) -> None:
    argparse.ArgumentParser(
        prog="collector.zone_join",
        description="물건을 법정동·정비구역 경계에 공간조인해 사전계산 표를 채운다",
    ).parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = load_config()
    # 둘 다 파생물이라 한 트랜잭션에서 같은 시점의 경계로 다시 만든다.
    with psycopg.connect(config.database_url) as conn:
        recompute_dong(conn)
        recompute_zone(conn)


if __name__ == "__main__":
    main()
