# 서울 열린데이터광장 용도지역(도시지역) SHP(OA-21136)를 PostGIS `zoning_district`에 적재한다.
from __future__ import annotations

import argparse
import logging
import re
import zipfile
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib import parse, request

import psycopg
import shapefile
from psycopg.rows import dict_row

from collector.building_age_loader import parse_base_ym
from collector.config import load_config
from collector.zone_shp_loader import polygon_wkt

logger = logging.getLogger(__name__)

# 파일형 데이터셋의 파일 다운로드 엔드포인트. 익명 POST로 전체 zip이 내려오는 것을 실측했다
# (2026-09-01, 10,860,324바이트) — 인증키·계정 불요가 이 원천의 채택 사유다
# (12-age-zoning-layer §2.2, 브이월드 폴리곤이 로그인 뒤라 수동 드롭인 것과 대비).
DOWNLOAD_URL = "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do"
DOWNLOAD_PARAMS = {"infId": "OA-21136", "seq": "6", "infSeq": "3"}

# cpg가 동봉되지 않는다. 같은 배포처 SHP들과 같은 cp949 계열로 읽는다 — 실측에서 명칭
# 8,308행이 온전히 읽히고 4행만 원천 자체가 깨져 있다(어느 인코딩으로도 복원 불가, §2.3).
SHP_ENCODING = "cp949"

# 원천 좌표계는 **파일명이 아니라 prj로** 판정했다. prj가 Korean_1985_Modified_Korea_Central_Belt
# (Bessel_1841, 중앙자오선 127.0028902777778도, 원점위도 38도, false 200000/500000) = EPSG:5174 —
# 정비구역 SHP(UD602)와 같고 법정동 SHP(GRS80 = 5186)와 다르다. pyproj의 prj 판정도 5174였고,
# 기준점 교차검증에서 5174는 위도 37.62(서울 안), 5186으로 잘못 읽으면 36.72(서울에서 남쪽
# 약 100km)가 나온다 (2026-09-01 실측).
SOURCE_SRID = 5174

# 좌표변환은 PostGIS 한 곳에서만 한다 (04-architecture).
TARGET_SRID = 4326

SOURCE = "SEOUL_OA21136"

# 원천 파일이 잘리거나 비어 내려온 날 전량 교체가 테이블을 통째로 비우는 사고를 막는
# 건수 대사 한계 (§2.5). 넘으면 적재하지 않고 실패로 알린다 — 조용한 소실 금지.
MAX_COUNT_CHANGE_RATIO = 0.3

# 채색 버킷 (§2.4). 값의 순서 = 국토계획법 시행령의 법정 세분 순서다(명도 사다리의 근거).
BUCKET_RES_EXCLUSIVE = "RES_EXCLUSIVE"  # 전용주거(제1·2종 합 — 실측 47폴리곤뿐)
BUCKET_RES_GENERAL_1 = "RES_GENERAL_1"  # 제1종일반주거
BUCKET_RES_GENERAL_2 = "RES_GENERAL_2"  # 제2종일반주거(7층이하 포함 — 법정 종 기준)
BUCKET_RES_GENERAL_3 = "RES_GENERAL_3"  # 제3종일반주거
BUCKET_RES_SEMI = "RES_SEMI"  # 준주거
BUCKET_OTHER = "OTHER"  # 그 밖의 용도지역(상업·공업·녹지 등) — 채색하지 않는 중립 표시

# 매핑 우선순위 ①: 소분류 코드 사전 (동봉 코드정의표 기준). UQA124(2종일반 7층이하)는 서울
# 고시 세부일 뿐 법정 종이 제2종일반이라 UQA122와 같은 버킷이다 (§2.4).
SCLAS_BUCKETS = {
    "UQA111": BUCKET_RES_EXCLUSIVE,
    "UQA112": BUCKET_RES_EXCLUSIVE,
    "UQA121": BUCKET_RES_GENERAL_1,
    "UQA122": BUCKET_RES_GENERAL_2,
    "UQA124": BUCKET_RES_GENERAL_2,
    "UQA123": BUCKET_RES_GENERAL_3,
}

# 매핑 우선순위 ②: 소분류 공란 행(실측 25%)의 중분류 사전. 준주거·전용주거만 채색 대상이고
# 그 밖의 중분류 코드는 전부 "그 밖"이다 (§2.4).
MLSFC_BUCKETS = {
    "UQA130": BUCKET_RES_SEMI,
    "UQA110": BUCKET_RES_EXCLUSIVE,
}

# 명칭에서 주거 세분 신호를 뽑는 규칙. "장위5구역 제2종일반주거지역"처럼 구역명 접두어가
# 붙은 변형이 많아 완전일치가 아니라 신호 추출로 대조한다 — 숫자+종은 "12층" 같은 층수와
# 헷갈리지 않게 "종" 글자까지 요구한다.
_CLASS_DIGIT_RE = re.compile(r"(\d)\s*종")
_CLASS_DIGIT_BUCKETS = {
    "1": BUCKET_RES_GENERAL_1,
    "2": BUCKET_RES_GENERAL_2,
    "3": BUCKET_RES_GENERAL_3,
}

# 인코딩이 깨진 명칭(실측 4행, '？'로 남는다)은 코드와의 대조 자체가 불가능하다.
_MOJIBAKE_CHARS = ("？", "�")


@dataclass(frozen=True)
class ZoningFeature:
    """SHP 한 행에서 뽑은 적재 단위. 코드·명칭은 전부 원문 그대로다."""

    present_sn: str | None
    lclas_cl: str | None
    mlsfc_cl: str | None
    sclas_cl: str | None
    zone_name_raw: str | None
    bucket: str | None
    area_m2: float | None
    notice_sn: str | None
    wkt: str | None


@dataclass(frozen=True)
class ZoningLoadResult:
    source_total: int
    loaded: int
    replaced: int
    repaired: int
    empty: int
    no_polygon: int
    unclassified: int


def name_class_signal(name: str) -> str | None:
    """명칭에서 주거 세분 신호를 뽑는다. 신호가 없으면 None — 없는 신호는 불일치가 아니다.

    "제2종전용주거지역"이 있어 전용주거를 숫자보다 먼저 본다. 숫자 판정은 "주거"가 같이
    있을 때만 한다 — "재정비촉진구역" 같은 비주거 명칭의 숫자를 종으로 읽지 않기 위해서다.
    """
    if "전용주거" in name:
        return BUCKET_RES_EXCLUSIVE
    if "준주거" in name:
        return BUCKET_RES_SEMI
    if "주거" in name:
        match = _CLASS_DIGIT_RE.search(name)
        if match:
            return _CLASS_DIGIT_BUCKETS.get(match.group(1))
    return None


def classify_bucket(sclas: str | None, mlsfc: str | None, name: str | None) -> str | None:
    """코드를 채색 버킷으로 매핑한다. None = 미분류(중립 렌더).

    우선순위는 §2.4 그대로: ① 소분류 사전 ② 소분류 공란이면 중분류 사전(사전 밖 코드는
    "그 밖") ③ 사전에 없는 소분류 코드·코드-명칭 불일치·깨진 명칭은 미분류. 명칭으로 코드를
    덮어쓰지 않는다 — 모르는 값을 가까운 버킷에 넣는 순간 허위 사실이 된다. 명칭은 버킷을
    깎는 데(불일치 → 미분류)만 쓴다.
    """
    if name is not None and any(char in name for char in _MOJIBAKE_CHARS):
        return None
    if sclas is not None:
        bucket = SCLAS_BUCKETS.get(sclas)
    elif mlsfc is not None:
        bucket = MLSFC_BUCKETS.get(mlsfc, BUCKET_OTHER)
    else:
        # 코드가 아예 없는 행(실측: UQA999 "기타 도시지역" 227행 등)은 무엇이라고도
        # 주장하지 않는다. "그 밖"도 "비주거"라는 주장이다.
        return None
    if bucket is None:
        return None
    signal = name_class_signal(name) if name is not None else None
    if bucket == BUCKET_OTHER:
        # 열이 밀려 중분류에 소분류 코드가 들어온 행(실측: UQA123 + "제3종일반주거지역")이
        # 실재한다 — 명칭이 주거 세분을 주장하면 "그 밖"으로 단정하지 않는다.
        return None if signal is not None else BUCKET_OTHER
    if signal is not None and signal != bucket:
        return None
    return bucket


def download_zip(dest: Path) -> int:
    """OA-21136 배포 zip을 내려받아 dest에 쓴다. 반환값은 바이트 수."""
    body = parse.urlencode(DOWNLOAD_PARAMS).encode("ascii")
    req = request.Request(DOWNLOAD_URL, data=body, method="POST")
    total = 0
    with request.urlopen(req, timeout=600) as resp, dest.open("wb") as out:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
    logger.info("zoning_download_done bytes=%s dest=%s", total, dest)
    return total


@contextmanager
def _open_reader(zip_path: Path) -> Iterator[shapefile.Reader]:
    """zip 안의 셰이프파일을 연다. 한글 폴더("shp파일/") 아래라 확장자로 찾는다."""
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


def _text(value: object) -> str | None:
    # 공란을 빈 문자열로 저장하면 화면이 "값 없음"과 "값이 빈칸"을 구분하지 못한다.
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def read_zoning_features(zip_path: Path) -> list[ZoningFeature]:
    """용도지역 SHP의 전 행을 읽는다.

    이터레이터(iterShapeRecords)를 쓰지 않고 인덱스로 도는 이유: 실측 1행이 POLYGON 타입인데
    점이 0개라 pyshp이 도형 생성 단계에서 던지고, 제너레이터는 거기서 통째로 죽는다.
    행 단위로 잡아야 나머지 8,311행을 살릴 수 있다.
    """
    features: list[ZoningFeature] = []
    with _open_reader(zip_path) as reader:
        for index in range(len(reader)):
            row = reader.record(index).as_dict()
            try:
                wkt = polygon_wkt(reader.shape(index))
            except shapefile.ShapefileException:
                # 행은 버리지 않는다 — 원천에 있었다는 사실을 남기고 도형만 없음으로 적는다.
                wkt = None
            sclas = _text(row["SCLAS_CL"])
            mlsfc = _text(row["MLSFC_CL"])
            name = _text(row["DGM_NM"])
            features.append(
                ZoningFeature(
                    present_sn=_text(row["PRESENT_SN"]),
                    lclas_cl=_text(row["LCLAS_CL"]),
                    mlsfc_cl=mlsfc,
                    sclas_cl=sclas,
                    zone_name_raw=name,
                    bucket=classify_bucket(sclas, mlsfc, name),
                    area_m2=row["DGM_AR"],
                    notice_sn=_text(row["NTFC_SN"]),
                    wkt=wkt,
                )
            )
    return features


# ST_MakeValid 후에 넣고, **고치기 전** 원천이 유효했는지를 같이 돌려받는다 (법정동 적재기와
# 같은 이유). wkt가 NULL인 행(도형 없음)은 CTE 전체가 NULL로 흘러 geom NULL로 들어간다 —
# 그 행의 source_valid·stored_empty도 NULL이라 호출부가 False/True와 구분해 센다.
_INSERT_SQL = """
WITH src AS (
    SELECT ST_Transform(ST_GeomFromText(%(wkt)s, %(source_srid)s), %(target_srid)s) AS geom
), fixed AS (
    SELECT ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3)) AS geom,
           ST_IsValid(geom) AS source_valid
    FROM src
), inserted AS (
    INSERT INTO zoning_district (
        source, base_ym, present_sn, lclas_cl, mlsfc_cl, sclas_cl,
        zone_name_raw, zoning_bucket, geom, area_m2, notice_sn, collected_at
    )
    SELECT %(source)s, %(base_ym)s, %(present_sn)s, %(lclas_cl)s, %(mlsfc_cl)s, %(sclas_cl)s,
           %(zone_name_raw)s, %(zoning_bucket)s, fixed.geom, %(area_m2)s, %(notice_sn)s, now()
    FROM fixed
    RETURNING ST_IsEmpty(geom) AS stored_empty
)
SELECT inserted.stored_empty, fixed.source_valid
FROM inserted, fixed
"""

# 전량 교체다 (§2.5) — PRESENT_SN이 유일하지 않아(실측 중복 41키) upsert 키가 없다.
# 같은 source만 지운다 — 폴백 원천으로 갈아탄 뒤에도 파일 한 장이 남의 레이어를 못 내린다.
_DELETE_SQL = "DELETE FROM zoning_district WHERE source = %(source)s"

_COUNT_SQL = "SELECT count(*) AS n FROM zoning_district WHERE source = %(source)s"


def load_zoning_district(database_url: str, zip_path: Path, base_ym: str) -> ZoningLoadResult:
    """용도지역을 멱등 적재한다. 전량 교체가 한 트랜잭션이라 두 번 돌려도 건수가 같다.

    zoning_district만 건드리므로 3시간마다 도는 수집 배치가 잡는 auction_item 락과 겹치지
    않는다. 실패하면 트랜잭션째 되돌아가 직전 적재분이 그대로 남는다.
    """
    parse_base_ym(base_ym)
    features = read_zoning_features(zip_path)
    if not features:
        raise ValueError(f"no zoning feature in {zip_path.name}")

    loaded = 0
    repaired = 0
    empty = 0
    no_polygon = 0

    with psycopg.connect(database_url) as conn:
        with conn.cursor(row_factory=dict_row) as cur:
            existing = cur.execute(_COUNT_SQL, {"source": SOURCE}).fetchone()["n"]
            if existing and abs(len(features) - existing) / existing > MAX_COUNT_CHANGE_RATIO:
                # 잘린 파일로 전량 교체하면 레이어가 통째로 사라진다. 급변은 사람 확인 뒤에만.
                raise ValueError(
                    f"zoning feature count changed too much: {existing} -> {len(features)}"
                )

            cur.execute(_DELETE_SQL, {"source": SOURCE})
            replaced = cur.rowcount

            for feature in features:
                if feature.wkt is None:
                    # 행을 조용히 버리지 않는다 — 몇 건이 도형 없이 들어갔는지 남긴다.
                    no_polygon += 1
                    logger.warning("zoning_no_polygon present_sn=%s", feature.present_sn)

                cur.execute(
                    _INSERT_SQL,
                    {
                        "wkt": feature.wkt,
                        "source_srid": SOURCE_SRID,
                        "target_srid": TARGET_SRID,
                        "source": SOURCE,
                        "base_ym": base_ym,
                        "present_sn": feature.present_sn,
                        "lclas_cl": feature.lclas_cl,
                        "mlsfc_cl": feature.mlsfc_cl,
                        "sclas_cl": feature.sclas_cl,
                        "zone_name_raw": feature.zone_name_raw,
                        "zoning_bucket": feature.bucket,
                        "area_m2": feature.area_m2,
                        "notice_sn": feature.notice_sn,
                    },
                )
                row = cur.fetchone()
                loaded += 1
                # wkt 없는 행은 둘 다 NULL이라 is False / truthy 로만 센다.
                if row["source_valid"] is False:
                    repaired += 1
                    logger.warning("zoning_invalid_source present_sn=%s", feature.present_sn)
                if row["stored_empty"]:
                    empty += 1
                    logger.warning("zoning_empty_after_repair present_sn=%s", feature.present_sn)

    # 미분류 원문을 적재 리포트로 남긴다 (§2.4 ③) — 사전을 넓힐지는 사람이 이걸 보고 정한다.
    unclassified_combos = Counter(
        (f.lclas_cl, f.mlsfc_cl, f.sclas_cl, f.zone_name_raw)
        for f in features
        if f.bucket is None
    )
    for (lclas, mlsfc, sclas, name), count in unclassified_combos.most_common():
        logger.warning(
            "zoning_unclassified lclas=%s mlsfc=%s sclas=%s name=%s rows=%s",
            lclas,
            mlsfc,
            sclas,
            name,
            count,
        )
    bucket_counts = Counter(f.bucket or "UNCLASSIFIED" for f in features)
    logger.info(
        "zoning_bucket_counts %s",
        " ".join(f"{bucket}={count}" for bucket, count in sorted(bucket_counts.items())),
    )

    result = ZoningLoadResult(
        source_total=len(features),
        loaded=loaded,
        replaced=replaced,
        repaired=repaired,
        empty=empty,
        no_polygon=no_polygon,
        unclassified=sum(unclassified_combos.values()),
    )
    logger.info(
        "zoning_district_load_done source_total=%s loaded=%s replaced=%s repaired=%s empty=%s "
        "no_polygon=%s unclassified=%s base_ym=%s",
        result.source_total,
        result.loaded,
        result.replaced,
        result.repaired,
        result.empty,
        result.no_polygon,
        result.unclassified,
        base_ym,
    )
    return result


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="collector.zoning_district_loader",
        description="용도지역(도시지역) SHP(OA-21136)를 zoning_district에 적재한다",
    )
    parser.add_argument("--zip", required=True, type=Path, help="OA-21136 배포 zip 경로")
    parser.add_argument(
        "--base-ym",
        required=True,
        help="기준연월 YYYY-MM — 배포 파일명의 YYYYMM(예: ..._202602.zip → 2026-02)에서 읽는다",
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help="적재 전에 원천 zip을 --zip 경로로 내려받는다",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.download:
        download_zip(args.zip)
    config = load_config()
    load_zoning_district(config.database_url, args.zip, args.base_ym)


if __name__ == "__main__":
    main()
