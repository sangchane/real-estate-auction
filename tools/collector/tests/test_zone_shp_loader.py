"""법정동 경계 SHP 적재기의 순수 변환부 테스트 — 링 방향·구멍 처리와 좌표계 판정."""

import shapefile

from collector.zone_shp_loader import SOURCE_SRID, polygon_wkt


def _shape(points, parts):
    return shapefile.Shape(shapeType=shapefile.POLYGON, points=points, parts=parts)


def test_single_ring_becomes_multipolygon():
    # 저장 컬럼이 MultiPolygon이라 링 하나짜리도 MULTIPOLYGON으로 감싸야 한다.
    shape = _shape([(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)], [0])

    assert polygon_wkt(shape) == "MULTIPOLYGON(((0 0,0 10,10 10,10 0,0 0)))"


def test_counter_clockwise_ring_becomes_a_hole_not_a_separate_polygon():
    """구멍(반시계 링)을 외곽으로 잘못 읽으면 면적이 뚫린 만큼이 아니라 더해져 틀린다."""
    shape = _shape(
        [
            (0, 0), (0, 10), (10, 10), (10, 0), (0, 0),
            (2, 2), (4, 2), (4, 4), (2, 4), (2, 2),
        ],
        [0, 5],
    )

    assert polygon_wkt(shape) == (
        "MULTIPOLYGON(((0 0,0 10,10 10,10 0,0 0),(2 2,4 2,4 4,2 4,2 2)))"
    )


def test_disjoint_clockwise_rings_become_separate_polygons():
    # 섬처럼 떨어진 외곽 둘은 구멍이 아니라 폴리곤 둘이다.
    shape = _shape(
        [
            (0, 0), (0, 1), (1, 1), (1, 0), (0, 0),
            (5, 5), (5, 6), (6, 6), (6, 5), (5, 5),
        ],
        [0, 5],
    )

    assert polygon_wkt(shape) == (
        "MULTIPOLYGON(((0 0,0 1,1 1,1 0,0 0)),((5 5,5 6,6 6,6 5,5 5)))"
    )


def test_null_shape_yields_no_geometry():
    # 폴리곤이 없는 행을 조용히 버리지 않으려면 호출부가 None을 구분할 수 있어야 한다.
    assert polygon_wkt(shapefile.Shape(shapeType=shapefile.NULL)) is None


def test_source_srid_is_5186_not_the_filename_5174():
    """파일명은 5174처럼 보이지만 prj는 GRS80(KGD2002 중부 2010)이다.

    5174(Bessel)로 넣으면 타원체가 달라 수백 미터 어긋난다. 상수를 바꾸려면 prj를 다시 볼 것.
    """
    assert SOURCE_SRID == 5186
