# 브이월드 법정동 경계 SHP(AL_D001)를 읽어 PostGIS `bjd_dong`에 적재한다.
from __future__ import annotations

import argparse
import io
import logging
import zipfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import psycopg
import shapefile
from psycopg.rows import dict_row

from collector.config import load_config

logger = logging.getLogger(__name__)

# AL_D001 배포본은 zip 안에 zip이 세 벌 들어 있다: 읍면동(EMD)·리(LIO)·시군구(SIG).
# 법정동 경계는 EMD 한 벌뿐이라 나머지는 열지 않는다 — LIO를 섞으면 '리'가 동과 같은 층위로
# 들어와 한 물건이 두 행에 걸리고, auction_item_dong의 "정확히 0..1" 전제가 깨진다.
EMD_MEMBER_SUFFIX = "(EMD).zip"

# cpg 파일이 949다. EUC-KR로 읽으면 확장 영역 글자가 섞인 동 이름에서 깨진다.
SHP_ENCODING = "cp949"

# 원천 좌표계는 **파일명이 아니라 prj로** 판정했다. prj가 KGD2002_Central_Belt_2010
# (GRS80, 중앙자오선 127도, 원점위도 38도, false 200000/600000) = EPSG:5186 이다.
# 같은 배포처의 정비구역 SHP(LSMD_CONT_UD602)는 파일명이 똑같이 5174처럼 보여도 prj가
# Bessel(Korean 1985)이라 EPSG:5174다. 타원체가 달라 바꿔 쓰면 수백 미터 어긋난다.
SOURCE_SRID = 5186

# 좌표변환은 PostGIS 한 곳에서만 한다 (04-architecture). pyproj(`geo.py`)는 기존 KATEC
# 경로 전용이다 — 변환 지점이 둘이면 결과가 어긋났을 때 어느 쪽이 맞는지 가릴 수 없다.
TARGET_SRID = 4326

# A4(시군구코드) 앞 두 자리. 서울만 쓴다 — 공간조인 대상 물건이 서울 5개 지방법원뿐이라
# 전국 5,370개를 넣어도 쓰는 곳이 없다.
SEOUL_SIGUNGU_PREFIX = "11"

_POLYGON_SHAPE_TYPES = (shapefile.POLYGON, shapefile.POLYGONZ, shapefile.POLYGONM)


@dataclass(frozen=True)
class DongFeature:
    """SHP 한 행에서 뽑은 적재 단위."""

    bjd_code: str
    dong_name: str
    sigungu: str
    base_date: date | None
    wkt: str | None


@dataclass(frozen=True)
class DongLoadResult:
    source_total: int
    loaded: int
    repaired: int
    empty: int
    deleted: int
    skipped_no_polygon: int


def polygon_wkt(shape: shapefile.Shape) -> str | None:
    """SHP 폴리곤을 MULTIPOLYGON WKT로 만든다. 폴리곤이 아니면 None.

    SHP는 링을 parts로 늘어놓기만 하고 외곽/구멍을 **링 방향**(시계=외곽, 반시계=구멍)으로만
    구분한다. 방향만 보고 자르면 구멍이 어느 외곽에 속하는지 알 수 없어, 외곽이 여럿인 동에서
    구멍이 엉뚱한 폴리곤에 붙는다. pyshp의 GeoJSON 변환이 방향과 포함관계를 함께 따져 주므로
    그 결과를 그대로 WKT로 옮긴다 (실측: 서울 467개 중 7개 동에 구멍 10개, 최대 7 parts).
    """
    if shape.shapeType not in _POLYGON_SHAPE_TYPES or not shape.points:
        return None

    geo = shape.__geo_interface__
    if geo["type"] == "Polygon":
        polygons = [geo["coordinates"]]
    elif geo["type"] == "MultiPolygon":
        polygons = list(geo["coordinates"])
    else:
        return None

    body = ",".join(_polygon_body(rings) for rings in polygons)
    return f"MULTIPOLYGON({body})" if body else None


def _polygon_body(rings: Sequence[Sequence[Sequence[float]]]) -> str:
    return "(" + ",".join(_ring_body(ring) for ring in rings) + ")"


def _ring_body(ring: Sequence[Sequence[float]]) -> str:
    return "(" + ",".join(f"{point[0]} {point[1]}" for point in ring) + ")"


@contextmanager
def _open_emd_reader(zip_path: Path) -> Iterator[shapefile.Reader]:
    """중첩 zip 안의 EMD 셰이프파일을 연다."""
    with zipfile.ZipFile(zip_path) as outer:
        members = [name for name in outer.namelist() if name.endswith(EMD_MEMBER_SUFFIX)]
        if len(members) != 1:
            raise ValueError(f"EMD zip not found in {zip_path.name}: {members}")

        with zipfile.ZipFile(io.BytesIO(outer.read(members[0]))) as inner:
            base = members[0][: -len(".zip")]
            with (
                inner.open(f"{base}.shp") as shp,
                inner.open(f"{base}.dbf") as dbf,
                inner.open(f"{base}.shx") as shx,
            ):
                yield shapefile.Reader(shp=shp, dbf=dbf, shx=shx, encoding=SHP_ENCODING)


def read_dong_features(zip_path: Path, *, sigungu_prefix: str) -> list[DongFeature]:
    """EMD 셰이프파일에서 대상 시군구의 법정동만 뽑는다.

    필드는 A0=일련번호 A1=법정동코드(8자리) A2=동이름 A3=기준일 A4=시군구코드(5자리).
    """
    features: list[DongFeature] = []
    with _open_emd_reader(zip_path) as reader:
        for shape_record in reader.iterShapeRecords():
            row = shape_record.record.as_dict()
            sigungu = str(row["A4"])
            if not sigungu.startswith(sigungu_prefix):
                continue
            base_date = row["A3"] if isinstance(row["A3"], date) else None
            features.append(
                DongFeature(
                    bjd_code=str(row["A1"]),
                    dong_name=str(row["A2"]),
                    sigungu=sigungu,
                    base_date=base_date,
                    wkt=polygon_wkt(shape_record.shape),
                )
            )
    return features


# ST_MakeValid 후에 넣고, **고치기 전** 원천이 유효했는지를 같이 돌려받는다. 고쳐서 넣기만 하면
# 원천이 깨져 있었다는 사실이 사라져 다음 배포본과 비교할 근거가 없다.
# ST_CollectionExtract(...,3)은 MakeValid가 선·점을 섞은 컬렉션을 돌려줄 때 폴리곤만 남긴다 —
# 컬렉션 그대로면 geometry(MultiPolygon,4326) 제약에 걸려 적재가 통째로 실패한다.
_UPSERT_SQL = """
WITH src AS (
    SELECT ST_Transform(ST_GeomFromText(%(wkt)s, %(source_srid)s), %(target_srid)s) AS geom
), upserted AS (
    INSERT INTO bjd_dong (bjd_code, dong_name, sigungu, geom, source_updated_at, collected_at)
    SELECT %(bjd_code)s, %(dong_name)s, %(sigungu)s,
           ST_Multi(ST_CollectionExtract(ST_MakeValid(src.geom), 3)),
           %(source_updated_at)s, now()
    FROM src
    ON CONFLICT (bjd_code) DO UPDATE SET
        dong_name = EXCLUDED.dong_name,
        sigungu = EXCLUDED.sigungu,
        geom = EXCLUDED.geom,
        source_updated_at = EXCLUDED.source_updated_at,
        collected_at = now()
    RETURNING bjd_code, ST_IsEmpty(geom) AS stored_empty
)
SELECT upserted.stored_empty, ST_IsValid(src.geom) AS source_valid
FROM upserted, src
"""

# 스키마 주석대로 전량 교체다(bjd_dong: "소프트삭제 없이 전량 교체"). 폐지된 동을 남기면
# 공간조인이 옛 경계를 계속 가리킨다. 이번에 읽은 시군구 범위 밖은 건드리지 않는다.
_DELETE_STALE_SQL = """
DELETE FROM bjd_dong
WHERE sigungu LIKE %(prefix)s
  AND NOT (bjd_code = ANY(%(codes)s))
"""


def load_bjd_dong(
    database_url: str,
    zip_path: Path,
    *,
    sigungu_prefix: str = SEOUL_SIGUNGU_PREFIX,
) -> DongLoadResult:
    """법정동 경계를 멱등 적재한다. 같은 bjd_code는 UPSERT라 두 번 돌려도 건수가 늘지 않는다.

    한 트랜잭션으로 끝낸다. bjd_dong과 그 참조 테이블만 건드리므로 3시간마다 도는 수집 배치가
    잡는 auction_item 락과 겹치지 않는다.
    """
    features = read_dong_features(zip_path, sigungu_prefix=sigungu_prefix)
    if not features:
        raise ValueError(f"no dong feature for sigungu prefix {sigungu_prefix}")

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
                    logger.warning("bjd_dong_no_polygon bjd_code=%s", feature.bjd_code)
                    continue

                cur.execute(
                    _UPSERT_SQL,
                    {
                        "wkt": feature.wkt,
                        "source_srid": SOURCE_SRID,
                        "target_srid": TARGET_SRID,
                        "bjd_code": feature.bjd_code,
                        "dong_name": feature.dong_name,
                        "sigungu": feature.sigungu,
                        # A3은 날짜뿐이라 timestamptz로 올리면 자정이 붙는다. 스키마가
                        # timestamptz라 그대로 두되, 시각 부분은 원천에 없는 값이다.
                        "source_updated_at": feature.base_date,
                    },
                )
                row = cur.fetchone()
                loaded += 1
                if not row["source_valid"]:
                    repaired += 1
                    logger.warning("bjd_dong_invalid_source bjd_code=%s", feature.bjd_code)
                if row["stored_empty"]:
                    empty += 1
                    logger.warning("bjd_dong_empty_after_repair bjd_code=%s", feature.bjd_code)

            cur.execute(
                _DELETE_STALE_SQL,
                {
                    "prefix": f"{sigungu_prefix}%",
                    "codes": [f.bjd_code for f in features if f.wkt is not None],
                },
            )
            deleted = cur.rowcount

    result = DongLoadResult(
        source_total=len(features),
        loaded=loaded,
        repaired=repaired,
        empty=empty,
        deleted=deleted,
        skipped_no_polygon=skipped_no_polygon,
    )
    logger.info(
        "bjd_dong_load_done source_total=%s loaded=%s repaired=%s empty=%s "
        "deleted=%s skipped_no_polygon=%s",
        result.source_total,
        result.loaded,
        result.repaired,
        result.empty,
        result.deleted,
        result.skipped_no_polygon,
    )
    return result


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="collector.zone_shp_loader",
        description="법정동 경계 SHP(AL_D001)를 bjd_dong에 적재한다",
    )
    parser.add_argument("--zip", required=True, type=Path, help="AL_D001 배포 zip 경로")
    parser.add_argument("--sigungu-prefix", default=SEOUL_SIGUNGU_PREFIX)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = load_config()
    load_bjd_dong(config.database_url, args.zip, sigungu_prefix=args.sigungu_prefix)


if __name__ == "__main__":
    main()
