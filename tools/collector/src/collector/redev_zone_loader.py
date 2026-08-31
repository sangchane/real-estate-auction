# 정비구역 SHP(LSMD_CONT_UD602)를 읽어 PostGIS `redevelopment_zone`에 적재한다.
from __future__ import annotations

import argparse
import logging
import zipfile
from collections import Counter
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import psycopg
import shapefile
from psycopg.rows import dict_row

from collector.config import load_config
from collector.zone_shp_loader import polygon_wkt

logger = logging.getLogger(__name__)

# cpg는 EUC-KR이라고 적혀 있지만 cp949로 읽는다 — cp949는 EUC-KR의 상위집합이라 확장 영역
# 글자가 섞인 구역명에서만 결과가 갈리고, 갈릴 때 cp949 쪽이 맞다 (법정동 SHP와 같은 이유).
SHP_ENCODING = "cp949"

# 원천 좌표계는 **파일명이 아니라 prj로** 판정했다. prj가 Korean 1985 / Modified Central Belt
# (Bessel 1841, 중앙자오선 127.00289도, 원점위도 38도) = EPSG:5174 다.
# 법정동 SHP(AL_D001)는 파일명이 똑같이 5174처럼 보여도 prj가 GRS80이라 EPSG:5186이다.
# 바꿔 쓰면 타원체가 달라 위도가 약 0.9도 어긋난다(실측: 같은 좌표가 37.44 대 36.54).
SOURCE_SRID = 5174

# 좌표변환은 PostGIS 한 곳에서만 한다 (04-architecture).
TARGET_SRID = 4326

# 05 계약의 식별자 체계 (source, source_zone_id, zone_kind).
SOURCE = "NSDI_UD602"
ZONE_KIND = "REDEV"


@dataclass(frozen=True)
class ZoneFeature:
    """SHP 한 행에서 뽑은 적재 단위. 문자열은 전부 원문 그대로다."""

    source_zone_id: str
    zone_name: str | None
    business_kind: str | None
    sigungu: str | None
    noticed_on: date | None
    wkt: str | None


@dataclass(frozen=True)
class ZoneLoadResult:
    source_total: int
    loaded: int
    repaired: int
    empty: int
    retired: int
    disambiguated: int
    skipped_no_polygon: int


def parse_notice_date(raw: str) -> date | None:
    """NTFDATE(YYYYMMDD)를 날짜로 읽는다. 공란·해석 불가는 None.

    실측 776행 중 525건이 공란이다. 못 읽은 값을 오늘이나 1970-01-01로 채우면 고시일이
    거짓이 되므로, 없는 날짜는 발명하지 않고 비운다.
    """
    text = raw.strip()
    if len(text) != 8:
        return None
    try:
        return datetime.strptime(text, "%Y%m%d").date()
    except ValueError:
        return None


def resolve_source_zone_ids(mnums: Sequence[str]) -> list[str]:
    """MNUM을 원천 식별자로 쓰되, **파일 안에서 겹치는 값에만** 일련번호를 덧붙인다.

    실측 2026-08 서울 파일은 776행 전부 고유해 접미사가 하나도 붙지 않는다. 그래도 이 처리를
    두는 이유는 같은 배포처의 다른 레이어에서 원천 식별자가 최대 13회 중복된 사례가 있어서다
    (12-age-zoning-layer, PRESENT_SN 중복 41건). 겹치는 채로 UPSERT하면 뒤 행이 앞 행을 덮어
    한 구역이 조용히 사라진다.

    고유한 값에는 붙이지 않는다 — 전 행에 붙이면 다음 배포본에서 행 순서가 한 칸만 밀려도
    776개 구역이 통째로 새 구역이 되고 옛 행은 전부 retired가 된다. 접미사가 붙은 행은
    그 위험을 그대로 안으므로 건수를 로그에 남긴다.
    """
    counts = Counter(mnums)
    return [f"{mnum}#{index}" if counts[mnum] > 1 else mnum for index, mnum in enumerate(mnums)]


@contextmanager
def _open_reader(zip_path: Path) -> Iterator[shapefile.Reader]:
    """zip 안의 셰이프파일을 연다. 법정동 배포본과 달리 중첩 zip이 아니다."""
    with zipfile.ZipFile(zip_path) as archive:
        members = [name for name in archive.namelist() if name.endswith(".shp")]
        if len(members) != 1:
            raise ValueError(f"exactly one shp expected in {zip_path.name}: {members}")

        base = members[0][: -len(".shp")]
        with (
            archive.open(f"{base}.shp") as shp,
            archive.open(f"{base}.dbf") as dbf,
            archive.open(f"{base}.shx") as shx,
        ):
            yield shapefile.Reader(shp=shp, dbf=dbf, shx=shx, encoding=SHP_ENCODING)


def _blank_to_none(raw: str) -> str | None:
    # 공란을 빈 문자열로 저장하면 화면이 "이름 없음"과 "이름이 빈칸"을 구분하지 못한다.
    text = raw.strip()
    return text or None


def read_zone_features(zip_path: Path) -> list[ZoneFeature]:
    """정비구역 SHP의 전 행을 읽는다.

    필드는 MNUM=원천 식별자 ALIAS=구역명 REMARK=사업 종류 NTFDATE=고시일
    SGG_OID=배포처 내부 일련번호 COL_ADM_SE=시군구코드.
    ALIAS·REMARK는 원문 그대로 옮긴다 — 실측에서 ALIAS 공란 563건, REMARK 공란 399건이고
    REMARK에 구역명이 들어온 행도 있지만, 우리가 어느 쪽이 이름인지 판정해 고쳐 적지 않는다.
    """
    with _open_reader(zip_path) as reader:
        rows = [(sr.record.as_dict(), sr.shape) for sr in reader.iterShapeRecords()]

    source_zone_ids = resolve_source_zone_ids([str(row["MNUM"]) for row, _ in rows])
    return [
        ZoneFeature(
            source_zone_id=source_zone_id,
            zone_name=_blank_to_none(str(row["ALIAS"])),
            business_kind=_blank_to_none(str(row["REMARK"])),
            sigungu=_blank_to_none(str(row["COL_ADM_SE"])),
            noticed_on=parse_notice_date(str(row["NTFDATE"])),
            wkt=polygon_wkt(shape),
        )
        for source_zone_id, (row, shape) in zip(source_zone_ids, rows, strict=True)
    ]


# ST_MakeValid 후에 넣고, **고치기 전** 원천이 유효했는지를 같이 돌려받는다 (법정동 적재기와 같은 이유).
# rep_point는 ST_PointOnSurface다 — ST_Centroid는 오목한 구역에서 폴리곤 밖에 찍혀 마커가
# 남의 구역 위에 선다.
# area_m2는 geography 면적이라 미터²다. 4326 그대로 ST_Area를 쓰면 단위가 제곱도라 뜻이 없다.
# retired_at = NULL은 **해제 규칙**이다(05 데이터 규칙, 08 m-03): 이번 파일에 있는 행은 다시
# 살아난 것으로 본다. 이게 없으면 오염 복구 절차(전체 retired 마킹 → 재적재)가 전 구역을
# 영구 retired로 만들어 지도에서 사라지게 한다.
_UPSERT_SQL = """
WITH src AS (
    SELECT ST_Transform(ST_GeomFromText(%(wkt)s, %(source_srid)s), %(target_srid)s) AS geom
), fixed AS (
    SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3)) AS geom,
           ST_IsValid(geom) AS source_valid
    FROM src
), upserted AS (
    INSERT INTO redevelopment_zone (
        source, source_zone_id, zone_kind, zone_name, sigungu, business_kind,
        geom, rep_point, area_m2, retired_at, source_updated_at, collected_at
    )
    SELECT %(source)s, %(source_zone_id)s, %(zone_kind)s,
           %(zone_name)s, %(sigungu)s, %(business_kind)s,
           fixed.geom,
           ST_PointOnSurface(fixed.geom),
           ST_Area(fixed.geom::geography),
           NULL,
           %(source_updated_at)s, now()
    FROM fixed
    ON CONFLICT (source, source_zone_id, zone_kind) DO UPDATE SET
        zone_name = EXCLUDED.zone_name,
        sigungu = EXCLUDED.sigungu,
        business_kind = EXCLUDED.business_kind,
        geom = EXCLUDED.geom,
        rep_point = EXCLUDED.rep_point,
        area_m2 = EXCLUDED.area_m2,
        retired_at = NULL,
        source_updated_at = EXCLUDED.source_updated_at,
        collected_at = now()
    RETURNING ST_IsEmpty(geom) AS stored_empty
)
SELECT upserted.stored_empty, fixed.source_valid
FROM upserted, fixed
"""

# 원천에서 사라진 구역은 지우지 않고 마킹만 한다 — 지우면 그 구역을 참조하던 물건 조인이
# 조용히 사라져 "구역 아님"과 "원천이 이번에 빠뜨림"을 구분할 수 없다 (021 주석, 엣지 B-5).
# 같은 (source, zone_kind) 안에서만 본다 — 다른 원천의 구역까지 건드리면 이 파일 한 장이
# 남의 레이어를 통째로 내린다 (04 소스별 격리).
_MARK_RETIRED_SQL = """
UPDATE redevelopment_zone
SET retired_at = now()
WHERE source = %(source)s
  AND zone_kind = %(zone_kind)s
  AND retired_at IS NULL
  AND NOT (source_zone_id = ANY(%(ids)s))
"""


def load_redevelopment_zone(database_url: str, zip_path: Path) -> ZoneLoadResult:
    """정비구역을 멱등 적재한다. 같은 (source, source_zone_id, zone_kind)는 UPSERT라
    두 번 돌려도 건수가 늘지 않는다.

    한 트랜잭션으로 끝낸다. redevelopment_zone만 건드리므로 3시간마다 도는 수집 배치가 잡는
    auction_item 락과 겹치지 않는다.
    """
    features = read_zone_features(zip_path)
    if not features:
        raise ValueError(f"no zone feature in {zip_path.name}")

    loaded = 0
    repaired = 0
    empty = 0
    skipped_no_polygon = 0

    with psycopg.connect(database_url) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            for feature in features:
                if feature.wkt is None:
                    # 행을 조용히 버리지 않는다 — 몇 건을 못 넣었는지 남긴다 (collector 관례).
                    skipped_no_polygon += 1
                    logger.warning("zone_no_polygon source_zone_id=%s", feature.source_zone_id)
                    continue

                cur.execute(
                    _UPSERT_SQL,
                    {
                        "wkt": feature.wkt,
                        "source_srid": SOURCE_SRID,
                        "target_srid": TARGET_SRID,
                        "source": SOURCE,
                        "source_zone_id": feature.source_zone_id,
                        "zone_kind": ZONE_KIND,
                        "zone_name": feature.zone_name,
                        "sigungu": feature.sigungu,
                        "business_kind": feature.business_kind,
                        # NTFDATE는 날짜뿐이라 timestamptz로 올리면 자정이 붙는다. 스키마가
                        # timestamptz라 그대로 두되, 시각 부분은 원천에 없는 값이다.
                        "source_updated_at": feature.noticed_on,
                    },
                )
                row = cur.fetchone()
                loaded += 1
                if not row["source_valid"]:
                    repaired += 1
                    logger.warning("zone_invalid_source source_zone_id=%s", feature.source_zone_id)
                if row["stored_empty"]:
                    empty += 1
                    logger.warning(
                        "zone_empty_after_repair source_zone_id=%s", feature.source_zone_id
                    )

            cur.execute(
                _MARK_RETIRED_SQL,
                {
                    "source": SOURCE,
                    "zone_kind": ZONE_KIND,
                    "ids": [f.source_zone_id for f in features if f.wkt is not None],
                },
            )
            retired = cur.rowcount

    result = ZoneLoadResult(
        source_total=len(features),
        loaded=loaded,
        repaired=repaired,
        empty=empty,
        retired=retired,
        disambiguated=sum(1 for f in features if "#" in f.source_zone_id),
        skipped_no_polygon=skipped_no_polygon,
    )
    logger.info(
        "redevelopment_zone_load_done source_total=%s loaded=%s repaired=%s empty=%s "
        "retired=%s disambiguated=%s skipped_no_polygon=%s",
        result.source_total,
        result.loaded,
        result.repaired,
        result.empty,
        result.retired,
        result.disambiguated,
        result.skipped_no_polygon,
    )
    return result


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="collector.redev_zone_loader",
        description="정비구역 SHP(LSMD_CONT_UD602)를 redevelopment_zone에 적재한다",
    )
    parser.add_argument("--zip", required=True, type=Path, help="정비구역 배포 zip 경로")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = load_config()
    load_redevelopment_zone(config.database_url, args.zip)


if __name__ == "__main__":
    main()
