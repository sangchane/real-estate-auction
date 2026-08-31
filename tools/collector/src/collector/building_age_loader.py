# 서울 열린데이터광장 건축물대장 표제부(OA-22424) CSV를 법정동별 노후도로 집계해 building_age_dong에 적재한다.
from __future__ import annotations

import argparse
import csv
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from urllib import parse, request

import psycopg

from collector.config import load_config

logger = logging.getLogger(__name__)

# OA-22424는 파일형이 아니라 시트형 데이터셋이라 파일 목록(nio_download.do)이 없고,
# 시트 CSV 엔드포인트가 전량을 내려준다. 익명(ssUserId=SAMPLE_VIEW)으로 585,301행 전량이
# 내려오는 것을 실측했다(2026-08-31, 262MB). 인증키가 필요 없다는 것이 이 원천의 채택 사유다.
DOWNLOAD_URL = "https://datafile.seoul.go.kr/bigfile/iot/sheet/csv/download.do"
DOWNLOAD_PARAMS = {
    "srvType": "S",
    "infId": "OA-22424",
    "serviceKind": "1",
    "pageNo": "1",
    "ssUserId": "SAMPLE_VIEW",
    "strWhere": "",
    "strOrderby": "",
    "filterCol": "",
    "txtFilter": "",
}

# 원천 인코딩은 CP949. 262MB 중 2바이트가 CP949 밖(기타구조 등 자유서술 필드의 잡음)이라
# strict로 읽으면 전체가 죽는다. 우리가 쓰는 세 컬럼(구·동·사용승인일자)에는 잡음이 없어
# replace로 읽어도 집계가 오염되지 않는다 (실측 2026-08-31).
CSV_ENCODING = "cp949"

# 헤더 컬럼명. 시트 CSV는 코드가 아니라 코드명(한글)만 내려준다 — 숫자 법정동코드가 없어
# bjd_dong과 (구명, 동명) 이름 조인을 한다. 실측: 서울 467개 동 전부가 이 조인으로 닫힌다.
GU_COL = "시군구코드명"
DONG_COL = "법정동코드명"
APR_COL = "사용승인일자"

SEOUL_SIGUNGU_PREFIX = "11"

# 사용승인일자 원문에는 "1957-  -"(월 결측), "-  -"(전부 결측), 1110년 같은 오타 연도가
# 실재한다(비표준 1,250행/585,301행). 연-월이 온전하고 연도가 그럴듯한 것만 "있음"으로 치고
# 나머지는 전부 결측(unknown_apr_count)으로 센다 — 모르는 값을 발명해 나이를 매기지 않는다.
_APR_RE = re.compile(r"^(\d{4})-(\d{2})-\d{2}$")
MIN_PLAUSIBLE_YEAR = 1800

_BASE_YM_RE = re.compile(r"^(\d{4})-(\d{2})$")

# 구명 표기 변형이 실재한다("서울특별시 강서구" 외에 "서울시노원구" 등 공백·약칭 변형 각 1행).
_GU_PREFIXES = ("서울특별시", "서울시")


@dataclass(frozen=True)
class DongAgeCounts:
    total: int = 0
    unknown: int = 0
    over20: int = 0
    over30: int = 0


@dataclass(frozen=True)
class AgeLoadResult:
    source_rows: int
    matched_rows: int
    unmatched_rows: int
    dong_count: int
    upserted: int
    base_ym: str


def parse_base_ym(raw: str) -> tuple[int, int]:
    match = _BASE_YM_RE.match(raw)
    if not match:
        raise ValueError(f"base-ym must be YYYY-MM: {raw!r}")
    year, month = int(match.group(1)), int(match.group(2))
    if not 1 <= month <= 12:
        raise ValueError(f"base-ym month out of range: {raw!r}")
    return year, month


def parse_apr_ym(raw: str) -> tuple[int, int] | None:
    """사용승인일자에서 (연, 월)을 뽑는다. 결측·비표준·오타 연도는 None."""
    match = _APR_RE.match(raw.strip())
    if not match:
        return None
    year, month = int(match.group(1)), int(match.group(2))
    if year < MIN_PLAUSIBLE_YEAR or not 1 <= month <= 12:
        return None
    return year, month


def age_years(apr: tuple[int, int], base: tuple[int, int]) -> int:
    """기준연월 대비 만 나이(년). 일 단위는 쓰지 않는다 — base_ym에 일이 없는데
    일로 자르면 없는 시각을 발명하는 것이 된다. 같은 달이면 채운 것으로 친다."""
    years = base[0] - apr[0]
    if base[1] < apr[1]:
        years -= 1
    return years


def normalize_gu(raw: str) -> str | None:
    """구명 원문을 "강서구" 꼴로 정규화한다. 서울 밖(실측: "경기도 군포시" 1행)은 None."""
    compact = raw.replace(" ", "")
    for prefix in _GU_PREFIXES:
        if compact.startswith(prefix):
            rest = compact[len(prefix) :]
            return rest or None
    return None


def download_csv(dest: Path) -> int:
    """표제부 CSV 전량을 내려받아 dest에 쓴다. 반환값은 바이트 수."""
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
    logger.info("building_age_download_done bytes=%s dest=%s", total, dest)
    return total


def _resolve_columns(header: list[str]) -> tuple[int, int, int]:
    index = {name: i for i, name in enumerate(header)}
    try:
        return index[GU_COL], index[DONG_COL], index[APR_COL]
    except KeyError as exc:
        raise ValueError(f"expected column missing in CSV header: {exc}") from exc


def aggregate_csv(
    csv_path: Path,
    base: tuple[int, int],
    bjd_rows: list[tuple[str, str, str]],
) -> tuple[dict[str, DongAgeCounts], int, int]:
    """CSV를 (구명, 동명)으로 bjd_code에 붙여 동별로 센다.

    반환: (bjd_code별 집계, 원천 행 수, 미매칭 행 수).

    동명은 서울 안에서 거의 유일하지만 중복이 실재한다(신사동: 은평/강남, 신정동: 마포/양천).
    구명→시군구코드 사전은 하드코딩하지 않고 **유일 동명 행의 투표로 학습**한다 — 표준 코드를
    외워 적으면 검증 없는 단정이 되고, 학습하면 bjd_dong과 원천이 서로를 검증한다
    (실측: 25개 구 전부 만장일치, 미매칭 0행).
    """
    by_dong: dict[str, list[tuple[str, str]]] = defaultdict(list)
    dong_names: dict[str, str] = {}
    for bjd_code, dong_name, sigungu in bjd_rows:
        by_dong[dong_name].append((bjd_code, sigungu))
        dong_names[bjd_code] = dong_name

    rows: list[tuple[str | None, str, tuple[int, int] | None]] = []
    votes: dict[str, Counter[str]] = defaultdict(Counter)
    source_rows = 0
    with csv_path.open(encoding=CSV_ENCODING, errors="replace", newline="") as f:
        reader = csv.reader(f)
        gu_i, dong_i, apr_i = _resolve_columns(next(reader))
        for row in reader:
            source_rows += 1
            gu = normalize_gu(row[gu_i])
            dong = row[dong_i].strip()
            rows.append((gu, dong, parse_apr_ym(row[apr_i])))
            if gu is not None:
                candidates = by_dong.get(dong)
                if candidates and len(candidates) == 1:
                    votes[gu][candidates[0][1]] += 1

    gu_to_sigungu: dict[str, str] = {}
    for gu, counter in votes.items():
        top, top_n = counter.most_common(1)[0]
        gu_to_sigungu[gu] = top
        if top_n != sum(counter.values()):
            # 소수 투표는 원천의 구 표기 오류다. 사전은 다수결로 확정하되 사실을 남긴다.
            logger.warning("building_age_gu_vote_impure gu=%s votes=%s", gu, dict(counter))

    tallies: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    unmatched: Counter[tuple[str | None, str]] = Counter()
    for gu, dong, apr in rows:
        candidates = by_dong.get(dong)
        bjd_code = None
        if candidates:
            if len(candidates) == 1:
                bjd_code = candidates[0][0]
            elif gu is not None:
                sigungu = gu_to_sigungu.get(gu)
                bjd_code = next((c for c, s in candidates if s == sigungu), None)
        if bjd_code is None:
            unmatched[(gu, dong)] += 1
            continue

        tally = tallies[bjd_code]
        if apr is None or apr[0] > base[0]:
            # 기준연월보다 미래인 승인 연도는 오타다 — 나이를 못 매기니 결측으로 센다.
            tally[1] += 1
            continue
        tally[0] += 1
        age = age_years(apr, base)
        if age >= 20:
            tally[2] += 1
        if age >= 30:
            tally[3] += 1

    for (gu, dong), count in unmatched.most_common(20):
        # 행을 조용히 버리지 않는다 — 무엇이 몇 건 안 붙었는지 남긴다 (collector 관례).
        logger.warning("building_age_unmatched gu=%s dong=%s rows=%s", gu, dong, count)

    counts = {
        code: DongAgeCounts(total=t[0], unknown=t[1], over20=t[2], over30=t[3])
        for code, t in tallies.items()
    }
    return counts, source_rows, sum(unmatched.values())


_UPSERT_SQL = """
INSERT INTO building_age_dong
    (bjd_code, base_ym, dong_name, total_count, unknown_apr_count,
     over20_count, over30_count, loaded_at)
VALUES
    (%(bjd_code)s, %(base_ym)s, %(dong_name)s, %(total)s, %(unknown)s,
     %(over20)s, %(over30)s, now())
ON CONFLICT (bjd_code, base_ym) DO UPDATE SET
    dong_name = EXCLUDED.dong_name,
    total_count = EXCLUDED.total_count,
    unknown_apr_count = EXCLUDED.unknown_apr_count,
    over20_count = EXCLUDED.over20_count,
    over30_count = EXCLUDED.over30_count,
    loaded_at = now()
"""

_SELECT_BJD_SQL = """
SELECT bjd_code, dong_name, sigungu FROM bjd_dong WHERE sigungu LIKE %(prefix)s
"""


def load_building_age(database_url: str, csv_path: Path, base_ym: str) -> AgeLoadResult:
    """동별 집계를 멱등 적재한다. PK(bjd_code, base_ym) UPSERT라 두 번 돌려도 행이 늘지 않는다.

    한 트랜잭션으로 끝내며 building_age_dong만 만진다 — 3시간마다 도는 수집 배치의
    auction_item 락과 겹치지 않는다.
    """
    base = parse_base_ym(base_ym)
    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(_SELECT_BJD_SQL, {"prefix": f"{SEOUL_SIGUNGU_PREFIX}%"})
            bjd_rows = [(r[0], r[1], r[2]) for r in cur.fetchall()]
            if not bjd_rows:
                raise ValueError("bjd_dong is empty — load zone_shp_loader first")

            counts, source_rows, unmatched_rows = aggregate_csv(csv_path, base, bjd_rows)
            dong_names = {code: name for code, name, _ in bjd_rows}

            upserted = 0
            for bjd_code, tally in counts.items():
                cur.execute(
                    _UPSERT_SQL,
                    {
                        "bjd_code": bjd_code,
                        "base_ym": base_ym,
                        "dong_name": dong_names[bjd_code],
                        "total": tally.total,
                        "unknown": tally.unknown,
                        "over20": tally.over20,
                        "over30": tally.over30,
                    },
                )
                upserted += 1

    result = AgeLoadResult(
        source_rows=source_rows,
        matched_rows=source_rows - unmatched_rows,
        unmatched_rows=unmatched_rows,
        dong_count=len(bjd_rows),
        upserted=upserted,
        base_ym=base_ym,
    )
    logger.info(
        "building_age_load_done base_ym=%s source_rows=%s matched=%s unmatched=%s "
        "upserted=%s dong_total=%s",
        result.base_ym,
        result.source_rows,
        result.matched_rows,
        result.unmatched_rows,
        result.upserted,
        result.dong_count,
    )
    return result


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="collector.building_age_loader",
        description="건축물대장 표제부(OA-22424) CSV를 building_age_dong에 집계 적재한다",
    )
    parser.add_argument("--csv", required=True, type=Path, help="표제부 CSV 경로")
    parser.add_argument(
        "--base-ym",
        required=True,
        help="기준연월 YYYY-MM — 데이터셋 페이지의 '데이터 갱신일'에서 사람이 읽어 넘긴다",
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help="적재 전에 원천 CSV를 --csv 경로로 내려받는다",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.download:
        download_csv(args.csv)
    config = load_config()
    load_building_age(config.database_url, args.csv, args.base_ym)


if __name__ == "__main__":
    main()
