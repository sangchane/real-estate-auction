"""용도지역 SHP 적재기의 순수 변환부 테스트 — 좌표계 판정·버킷 매핑·도형 없는 행 (12 §2.4).

DB 없이 돈다. 셰이프파일은 pyshp Writer로 메모리에 만들어 zip으로 싼다 — 배포 원본 10MB를
저장소에 두지 않기 위해서다. 코드·명칭 값은 2026-09-01 실파일 실측에서 그대로 가져왔다.
"""

import io
import zipfile

import shapefile

from collector.redev_zone_loader import SOURCE_SRID as REDEV_SOURCE_SRID
from collector.zone_shp_loader import SOURCE_SRID as DONG_SOURCE_SRID
from collector.zoning_district_loader import (
    BUCKET_OTHER,
    BUCKET_RES_EXCLUSIVE,
    BUCKET_RES_GENERAL_1,
    BUCKET_RES_GENERAL_2,
    BUCKET_RES_GENERAL_3,
    BUCKET_RES_SEMI,
    SOURCE_SRID,
    classify_bucket,
    read_zoning_features,
)

# 배포본의 실제 구성 — 한글 폴더 아래라 확장자로 찾는지도 함께 본다.
_BASE = "shp파일/UPIS_C_UQ111"

_SQUARE = [[(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)]]


def _zoning_zip(tmp_path, rows, *, with_null_shape=False):
    """(PRESENT_SN, LCLAS, MLSFC, SCLAS, DGM_NM, DGM_AR, NTFC_SN) 행들로 배포본 모양 zip을 만든다."""
    shp, dbf, shx = io.BytesIO(), io.BytesIO(), io.BytesIO()
    writer = shapefile.Writer(shp=shp, dbf=dbf, shx=shx, encoding="cp949")
    writer.field("PRESENT_SN", "C", 50)
    writer.field("LCLAS_CL", "C", 6)
    writer.field("MLSFC_CL", "C", 6)
    writer.field("SCLAS_CL", "C", 12)
    writer.field("DGM_NM", "C", 200)
    writer.field("DGM_AR", "N", 19, 8)
    writer.field("NTFC_SN", "C", 20)
    for index, row in enumerate(rows):
        if with_null_shape and index == len(rows) - 1:
            writer.null()
        else:
            writer.poly(_SQUARE)
        writer.record(*row)
    writer.close()

    path = tmp_path / "zoning.zip"
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(f"{_BASE}.shp", shp.getvalue())
        archive.writestr(f"{_BASE}.dbf", dbf.getvalue())
        archive.writestr(f"{_BASE}.shx", shx.getvalue())
    return path


def test_source_srid_is_5174_like_redev_zone_not_dong():
    """prj가 Bessel(Korean 1985 수정중부, 원점위도 38, FN 500000)이라 5174다.

    정비구역 SHP와 같고 법정동 SHP(GRS80=5186)와 다르다. 바꿔 쓰면 타원체가 달라 위도가
    약 0.9도 어긋난다(실측: 같은 좌표가 5174→37.62 서울 안, 5186→36.72 서울 밖).
    상수를 바꾸려면 prj를 다시 볼 것.
    """
    assert SOURCE_SRID == 5174
    assert SOURCE_SRID == REDEV_SOURCE_SRID
    assert SOURCE_SRID != DONG_SOURCE_SRID


def test_sclas_dictionary_maps_residential_subclasses():
    # UQA124(7층이하)는 서울 고시 세부일 뿐 법정 종이 제2종일반이라 UQA122와 같은 버킷이다.
    assert classify_bucket("UQA111", "UQA110", "제1종전용주거지역") == BUCKET_RES_EXCLUSIVE
    assert classify_bucket("UQA112", "UQA110", "제2종전용주거지역") == BUCKET_RES_EXCLUSIVE
    assert classify_bucket("UQA121", "UQA120", "제1종일반주거지역") == BUCKET_RES_GENERAL_1
    assert classify_bucket("UQA122", "UQA120", "제2종일반주거지역") == BUCKET_RES_GENERAL_2
    assert classify_bucket("UQA124", "UQA120", "제2종일반주거지역(7층이하)") == BUCKET_RES_GENERAL_2
    assert classify_bucket("UQA123", "UQA120", "제3종일반주거지역") == BUCKET_RES_GENERAL_3


def test_blank_sclas_falls_back_to_mlsfc_dictionary():
    # 준주거·상업·녹지 등 실측 25%는 소분류가 공란이고 중분류에만 코드가 있다.
    assert classify_bucket(None, "UQA130", "준주거지역") == BUCKET_RES_SEMI
    assert classify_bucket(None, "UQA110", "전용주거지역") == BUCKET_RES_EXCLUSIVE
    assert classify_bucket(None, "UQA220", "일반상업지역") == BUCKET_OTHER
    assert classify_bucket(None, "UQA430", "자연녹지지역") == BUCKET_OTHER


def test_unknown_codes_stay_unclassified():
    """사전에 없는 코드는 명칭이 그럴듯해도 배정하지 않는다 — 추측 배정은 허위 사실이 된다."""
    # 원천 스스로 "기타/미분류"라 한 소분류 코드 (실측 UQA129 5행, UQA119 3행).
    assert classify_bucket("UQA129", "UQA120", "일반주거지역기타") is None
    assert classify_bucket("UQA119", "UQA110", "전용주거지역 미분류") is None
    # 소분류 자리에 들어온 중분류·타 체계 코드와 리터럴 "null" (실측 각 1~2행).
    assert classify_bucket("UQA220", "UQA220", "일반상업지역") is None
    assert classify_bucket("UQ1221", "UQ1220", "재정비촉진구역") is None
    assert classify_bucket("null", "UQA220", "일반상업지역") is None
    # 코드가 아예 없는 행 (실측: UQA999 "기타 도시지역" 227행 — 대분류는 매핑 키가 아니다).
    assert classify_bucket(None, None, "기타 도시지역") is None
    assert classify_bucket(None, None, None) is None


def test_code_name_conflict_is_not_colored():
    # 실측 실존 조합들 — 코드와 명칭이 서로 다른 종을 주장하면 어느 쪽도 편들지 않는다.
    assert classify_bucket("UQA122", "UQA120", "제3종일반주거지역") is None
    assert classify_bucket("UQA123", "UQA120", "준주거지역") is None
    assert classify_bucket("UQA121", "UQA120", "제2종일반주거지역(12층이하)") is None
    assert classify_bucket(None, "UQA130", "제2종일반주거지역") is None


def test_name_variants_are_not_conflicts():
    # 구역명 접두어·층수 표기·조사 변형은 종 신호가 같으므로 불일치가 아니다 (전부 실측 명칭).
    assert classify_bucket("UQA122", "UQA120", "장위5구역 제2종일반주거지역") == BUCKET_RES_GENERAL_2
    assert classify_bucket("UQA122", "UQA120", "2종일반주거지역(12층이하)") == BUCKET_RES_GENERAL_2
    assert classify_bucket("UQA124", "UQA120", "2종일반주거(7층이하)") == BUCKET_RES_GENERAL_2
    assert (
        classify_bucket("UQA121", "UQA120", "녹번 제1-2지구 제1종일반주거지역")
        == BUCKET_RES_GENERAL_1
    )
    # 명칭에 종 신호가 아예 없으면(사업명 등) 코드를 따른다 — 없는 신호는 불일치가 아니다.
    assert classify_bucket("UQA124", "UQA120", "토지구획정리사업") == BUCKET_RES_GENERAL_2


def test_mojibake_name_cannot_be_verified_so_unclassified():
    # 인코딩이 깨진 명칭(실측 4행)은 코드와의 대조 자체가 불가능하다 — 검증 못 한 값은 안 칠한다.
    assert classify_bucket("UQA123", "UQA120", "？？3醫？？쇰？二쇨굅吏？？？") is None
    assert classify_bucket(None, "UQA130", "以？二쇨굅吏？？？") is None


def test_other_bucket_with_residential_name_is_unclassified():
    # 열이 밀려 중분류 자리에 소분류 코드가 들어온 행이 실재한다 — "그 밖"으로 단정하지 않는다.
    assert classify_bucket(None, "UQA123", "제3종일반주거지역") is None
    assert classify_bucket(None, "UQA190", "준주거지역") is None
    # 명칭이 주거를 주장하지 않으면 중분류대로 "그 밖"이다.
    assert classify_bucket(None, "UQA330", "중공업지역") == BUCKET_OTHER


def test_rows_without_polygon_are_kept_with_raw_fields(tmp_path):
    # 실측 1행이 도형 없이 온다. 행을 버리면 원천에 있었다는 사실이 사라진다 — wkt만 None이다.
    path = _zoning_zip(
        tmp_path,
        [
            ("11000-1", "UQA100", "UQA120", "UQA122", "제2종일반주거지역", 1234.5, "고시 제2020-1호"),
            ("11000-2", "UQA100", "", "", "", 0.0, ""),
        ],
        with_null_shape=True,
    )

    features = read_zoning_features(path)

    assert len(features) == 2
    first, second = features
    assert first.present_sn == "11000-1"
    assert first.bucket == BUCKET_RES_GENERAL_2
    assert first.notice_sn == "고시 제2020-1호"
    assert first.area_m2 == 1234.5
    assert first.wkt is not None
    # 공란은 빈 문자열이 아니라 None — 화면이 "값 없음"과 "빈칸"을 구분해야 한다.
    assert second.wkt is None
    assert second.sclas_cl is None
    assert second.zone_name_raw is None
    assert second.bucket is None
