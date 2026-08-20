# PDF 표 구조(괘선) -> 점유자 표 파싱 테스트. 픽스처는 법원 실측 문서를 원문 그대로 담는다.
import json
from datetime import date
from pathlib import Path

from collector.notice_pdf_parser import parse_tenant_table_from_cells

FIXTURES = Path(__file__).parent / "fixtures"


def _real() -> dict:
    return json.loads(
        (FIXTURES / "notice_pdf_cells_103032_1.json").read_text(encoding="utf-8")
    )


def _cell(row, col, text, *, row_span=1, col_span=1):
    return {
        "type": "table cell",
        "row number": row,
        "column number": col,
        "row span": row_span,
        "column span": col_span,
        "kids": [{"type": "paragraph", "content": text}],
    }


def _table(rows, *, columns):
    return {
        "type": "table",
        "number of rows": len(rows),
        "number of columns": columns,
        "rows": [
            {"type": "table row", "row number": i, "cells": cells}
            for i, cells in enumerate(rows, start=1)
        ],
    }


def _header(row):
    return [
        _cell(row, 1, "점유자 성 명"),
        _cell(row, 2, "점유 부분"),
        _cell(row, 3, "정보출처 구 분"),
        _cell(row, 4, "보 증 금"),
        _cell(row, 5, "전입신고일자· 사업자등 록 신청일자"),
    ]


def test_real_notice_splits_two_tenants():
    """실측 회귀 — 좌표 파서가 한 명으로 뭉치던 명세서다 (WP-11 §4-29).

    2025타경103032 물건1: 전세권자 3억과 임차인 2억6,955만이 각각 다른 행인데, 텍스트 레이어
    파서는 정보출처가 '등기사항전부증명서현황조사'로 붙은 1행 1명으로 저장했고 2억6,955만을
    통째로 잃었다. 괘선에는 두 행의 경계가 있다.
    """
    table = parse_tenant_table_from_cells(_real())

    assert len(table.tenants) == 2
    assert table.rejected == 0
    first, second = table.tenants
    assert (first.tenant_seq, second.tenant_seq) == (1, 2)
    assert first.source_kind == "등기사항전부증명서"
    assert first.deposit_amount == 300_000_000
    assert second.source_kind == "현황조사"
    assert second.deposit_amount == 269_550_000
    assert second.move_in_date == date(2017, 1, 9)


def test_real_notice_joins_name_broken_by_line_wrap():
    """셀 안 줄바꿈으로 조각난 성명을 하나로 잇는다.

    PDF는 좁은 셀에서 '주식회 사 스타벅 스커피 코리아'처럼 줄을 나눈다. 조각 사이 공백을
    남기면 DB에 다른 문자열로 쌓여 동일인 묶기가 깨진다 (WP-11 §4-27의 `주식회` 사례).
    """
    first, second = parse_tenant_table_from_cells(_real()).tenants

    assert first.tenant_name == "주식회사스타벅스커피코리아"
    assert second.tenant_name == "주식회사에스씨케이컴퍼니"


def test_row_span_name_makes_one_person_across_rows():
    """성명 병합셀이 덮는 행들은 한 사람이다 — 이것이 괘선을 쓰는 이유다.

    한 임차인이 정보출처별로 여러 행을 가지면 성명은 병합셀에 한 번만 렌더된다. 좌표만으로는
    그 경계를 복원할 수 없어 두 사람으로 갈리거나(§4-27) 이웃을 삼켰다(§4-29).
    """
    document = {
        "kids": [
            _table(
                [
                    _header(1),
                    [
                        _cell(2, 1, "김철수", row_span=2),
                        _cell(2, 2, "101호"),
                        _cell(2, 3, "현황조사"),
                        _cell(2, 4, "50,000,000"),
                        _cell(2, 5, "2020.01.02."),
                    ],
                    [  # 성명 셀이 없다 — 위 병합셀에 덮인 행이다
                        _cell(3, 2, "101호"),
                        _cell(3, 3, "권리신고"),
                        _cell(3, 4, "50,000,000"),
                        _cell(3, 5, "2020.01.02."),
                    ],
                ],
                columns=5,
            )
        ]
    }

    table = parse_tenant_table_from_cells(document)

    assert len(table.tenants) == 2  # 행은 둘
    assert {tenant.tenant_seq for tenant in table.tenants} == {1}  # 사람은 하나
    assert [tenant.source_kind for tenant in table.tenants] == ["현황조사", "권리신고"]


def test_adjacent_short_names_stay_two_people():
    """이웃한 짧은 이름 둘은 두 사람이다.

    위 테스트와 짝이다. 좌표 파서는 이 둘을 구분하지 못해 한 명으로 합치거나 갈랐다 —
    성명 줄바꿈 간격과 인접 행 간격이 겹치기 때문이다 (WP-11 §4-30에서 좌표안을 기각한 근거).
    """
    document = {
        "kids": [
            _table(
                [
                    _header(1),
                    [
                        _cell(2, 1, "김철수"),
                        _cell(2, 2, "101호"),
                        _cell(2, 3, "현황조사"),
                        _cell(2, 4, "10,000,000"),
                        _cell(2, 5, "2021.08.20."),
                    ],
                    [
                        _cell(3, 1, "이영희"),
                        _cell(3, 2, "102호"),
                        _cell(3, 3, "현황조사"),
                        _cell(3, 4, "15,000,000"),
                        _cell(3, 5, "2021.06.22."),
                    ],
                ],
                columns=5,
            )
        ]
    }

    table = parse_tenant_table_from_cells(document)

    assert {tenant.tenant_seq for tenant in table.tenants} == {1, 2}
    assert [tenant.deposit_amount for tenant in table.tenants] == [10_000_000, 15_000_000]


def test_stops_at_full_width_row():
    """전 컬럼을 덮는 행(<비고> 등)에서 표가 끝난다 — 주의사항 문구를 임차인으로 읽지 않는다."""
    document = {
        "kids": [
            _table(
                [
                    _header(1),
                    [
                        _cell(2, 1, "김철수"),
                        _cell(2, 2, "101호"),
                        _cell(2, 3, "현황조사"),
                        _cell(2, 4, "50,000,000"),
                        _cell(2, 5, "2020.01.02."),
                    ],
                    [_cell(3, 1, "<비고>", col_span=5)],
                    [_cell(4, 1, "※ 최선순위 설정일자보다 …", col_span=5)],
                ],
                columns=5,
            )
        ]
    }

    table = parse_tenant_table_from_cells(document)

    assert len(table.tenants) == 1
    assert table.tenants[0].tenant_name == "김철수"


def test_returns_empty_when_no_tenant_table():
    """점유자 표가 없는 문서에서 엉뚱한 값을 만들지 않는다."""
    document = {"kids": [_table([[_cell(1, 1, "부동산의 표시")]], columns=1)]}

    table = parse_tenant_table_from_cells(document)

    assert table.tenants == ()
    assert table.rejected == 0
