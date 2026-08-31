"""정비구역 SHP 적재기의 순수 변환부 테스트 — 좌표계 판정·공란 처리·원천ID 중복 (TS-02).

DB 없이 돈다. 셰이프파일은 pyshp Writer로 메모리에 만들어 zip으로 싸므로 배포 원본이 없어도
회귀를 잡는다 — 원본은 로그인 뒤에 있어 저장소에 둘 수 없다 (DA-09).
"""

import io
import zipfile
from datetime import date

import shapefile

from collector.redev_zone_loader import (
    SOURCE_SRID,
    parse_notice_date,
    read_zone_features,
    resolve_source_zone_ids,
)
from collector.zone_shp_loader import SOURCE_SRID as DONG_SOURCE_SRID

# 배포본 파일명 규칙. 안쪽 파일 이름이 zip 이름과 달라 확장자로 찾는지도 함께 본다.
_BASE = "LSMD_CONT_UD602_5174_11_202608"

_SQUARE = [[(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)]]


def _zone_zip(tmp_path, rows, *, with_null_shape=False):
    """(MNUM, ALIAS, REMARK, NTFDATE, SGG_OID, COL_ADM_SE) 행들로 배포본 모양의 zip을 만든다."""
    shp, dbf, shx = io.BytesIO(), io.BytesIO(), io.BytesIO()
    writer = shapefile.Writer(shp=shp, dbf=dbf, shx=shx, encoding="cp949")
    writer.field("MNUM", "C", 33)
    writer.field("ALIAS", "C", 200)
    writer.field("REMARK", "C", 200)
    writer.field("NTFDATE", "C", 8)
    writer.field("SGG_OID", "N", 10)
    writer.field("COL_ADM_SE", "C", 5)
    for index, row in enumerate(rows):
        if with_null_shape and index == len(rows) - 1:
            writer.null()
        else:
            writer.poly(_SQUARE)
        writer.record(*row)
    writer.close()

    path = tmp_path / "zones.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(f"{_BASE}.shp", shp.getvalue())
        archive.writestr(f"{_BASE}.dbf", dbf.getvalue())
        archive.writestr(f"{_BASE}.shx", shx.getvalue())
        archive.writestr(f"{_BASE}.cpg", "EUC-KR")
    return path


def test_source_srid_is_5174_and_differs_from_the_dong_file():
    """두 SHP는 파일명이 똑같이 5174처럼 보이지만 prj의 타원체가 다르다.

    정비구역은 Bessel(Korean 1985)=5174, 법정동은 GRS80(KGD2002 중부 2010)=5186이다.
    바꿔 쓰면 위도가 약 0.9도(100km 남짓) 어긋난다(실측: 같은 좌표가 37.44 대 36.54).
    """
    assert SOURCE_SRID == 5174
    assert SOURCE_SRID != DONG_SOURCE_SRID


def test_blank_alias_and_blank_notice_date_become_null(tmp_path):
    # 실측 776행 중 ALIAS 공란이 563건, NTFDATE 공란이 525건이다. 공란을 빈 문자열로 넣으면
    # 화면이 "이름 없음"과 "이름이 빈칸"을 구분하지 못한다.
    path = _zone_zip(tmp_path, [("M1", "", "효제1구역", "", 1, "11110")])

    features = read_zone_features(path)

    assert len(features) == 1
    feature = features[0]
    assert feature.zone_name is None
    assert feature.noticed_on is None
    # REMARK는 사업 종류든 구역명이든 원문 그대로 남긴다 — 우리가 고쳐 적지 않는다.
    assert feature.business_kind == "효제1구역"
    assert feature.sigungu == "11110"


def test_notice_date_and_alias_are_kept_as_published(tmp_path):
    path = _zone_zip(
        tmp_path,
        [("M1", "정비구역", "신영동 너와나우리마을 주거환경관리사업", "20180222", 1, "11110")],
    )

    feature = read_zone_features(path)[0]

    assert feature.zone_name == "정비구역"
    assert feature.noticed_on == date(2018, 2, 22)


def test_unparsable_notice_date_is_dropped_not_guessed():
    # 8자리가 아니거나 달력에 없는 날짜는 버린다 — 없는 날짜를 지어내면 고시일이 거짓이 된다.
    assert parse_notice_date("") is None
    assert parse_notice_date("2018") is None
    assert parse_notice_date("20180230") is None


def test_duplicate_source_id_gets_a_file_sequence_suffix():
    """겹치는 MNUM에만 접미사를 붙인다.

    접미사가 없으면 뒤 행이 앞 행을 UPSERT로 덮어 한 구역이 조용히 사라진다.
    고유한 값에까지 붙이면 다음 배포본에서 행 순서가 바뀔 때 전 구역이 새 구역으로 보인다.
    """
    assert resolve_source_zone_ids(["A", "B", "A"]) == ["A#0", "B", "A#2"]
    assert resolve_source_zone_ids(["A", "B"]) == ["A", "B"]


def test_row_without_polygon_keeps_its_row_with_no_geometry(tmp_path):
    # 도형 없는 행을 조용히 버리지 않는다 — 호출부가 몇 건을 못 넣었는지 셀 수 있어야 한다.
    path = _zone_zip(
        tmp_path,
        [("M1", "", "가", "", 1, "11110"), ("M2", "", "나", "", 2, "11110")],
        with_null_shape=True,
    )

    features = read_zone_features(path)

    assert [f.wkt is None for f in features] == [False, True]
