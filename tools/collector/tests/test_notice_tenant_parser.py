# 명세서 PDF 텍스트 레이어 → 점유자 표 파싱 테스트 (실측 좌표 픽스처 + 경계값)
# 픽스처는 법원 실측 응답을 **원문 그대로** 담는다 — 성명도 가리지 않는다 (007, 사용자 결정
# 2026-07-30). 성명은 민감정보가 아니고 법원이 공개한 정보다. 가명으로 바꾸면 실제 레이아웃과
# 글자 폭이 달라져 좌표 기반 파싱의 회귀를 못 잡는다.
# (notice_pdf_texts_*.json 중 일부는 이 결정 이전에 뜬 것이라 가명이 남아 있다)
import json
from datetime import date
from pathlib import Path

import pytest

from collector.notice_tenant_parser import parse_tenant_table

FIXTURES = Path(__file__).parent / "fixtures"
PAGE0_FIXTURE = FIXTURES / "notice_pdf_texts_page0.json"


def _page0() -> list[dict]:
    return json.loads(PAGE0_FIXTURE.read_text(encoding="utf-8"))


def _pages(name: str) -> list[list[dict]]:
    return [json.loads((FIXTURES / name).read_text(encoding="utf-8"))]


def test_parses_two_source_rows_of_same_property():
    table = parse_tenant_table([_page0()])

    assert len(table.tenants) == 2
    assert [t.source_kind for t in table.tenants] == ["등기사항전부증명서", "권리신고"]
    assert [t.occupied_part for t in table.tenants] == ["206호", "206호"]


def test_reassembles_cells_wrapped_across_lines():
    first, second = parse_tenant_table([_page0()]).tenants

    # 컬럼 폭보다 긴 값은 셀 안에서 줄바꿈된다 — 위→아래로 이어붙여야 원문이 된다
    assert first.source_kind == "등기사항전부증명서"
    assert first.possession_basis == "주거 주택임차권자"
    assert second.tenant_name == "주택도시보증공사"
    assert second.possession_basis == "주거 임차인"


def test_extracts_dates_amounts_and_distribution_demand():
    first, second = parse_tenant_table([_page0()]).tenants

    assert first.deposit_amount == 230_000_000
    assert first.move_in_date == date(2021, 6, 4)
    assert first.fixed_date == date(2021, 6, 4)
    assert first.monthly_rent is None  # 차임 공란은 흔하다
    assert first.lease_period == "2021.06.04~"
    assert first.demanded_distribution is None  # 공란 — 요구 안 했다고 단정하지 않는다

    assert second.demanded_distribution is True
    assert second.demanded_distribution_date == date(2023, 11, 30)


def test_demanded_distribution_never_guesses_true_from_unknown_text():
    """배당요구여부는 날짜나 "없음"류가 아니면 단정하지 않는다.

    예전 규칙(`"없" not in text`)은 "미상"·"불명"·"-" 를 True 로 기록해 배당요구를 한 것으로
    뒤집었다 — 개발 DB에 날짜 없는 true 3행이 그 흔적이다. False 경로는 설계상 존재했지만
    단정 테스트가 없어 회귀를 못 잡았다 (WP-11 §4-26).
    """
    from collector.notice_tenant_parser import _parse_demanded

    # 법원이 명시적으로 적은 "없음"류만 False 다
    assert _parse_demanded("없음", None) is False
    assert _parse_demanded("해당없음", None) is False

    # 판독 불가 표기를 "요구했다"로 뒤집지 않는다
    assert _parse_demanded("미상", None) is None
    assert _parse_demanded("불명", None) is None
    assert _parse_demanded("-", None) is None

    # 공란도 여전히 보류다 (요구 안 했다고 단정하지 않는다)
    assert _parse_demanded(None, None) is None

    # 일자가 잡히면 요구한 것이다 — 이 경로만 True 를 만든다
    assert _parse_demanded("2023.11.30.", date(2023, 11, 30)) is True


def test_assigns_tenant_seq_per_person_not_per_row():
    tenants = parse_tenant_table([_page0()]).tenants

    # 이름이 다르면 순번도 다르다
    assert [t.tenant_seq for t in tenants] == [1, 2]


def test_marks_table_as_terminated_when_remarks_section_present():
    assert parse_tenant_table([_page0()]).continued is False


def test_multi_line_occupied_part_does_not_split_rows():
    # 2022타경52802 물건2 — 점유부분이 5줄로 감싸이며 §4-7 수율 붕괴를 일으킨 실측 문서.
    # 표의 실제 행은 3개: 현황조사(전부 미상 → 게이트 거부), 현황조사, 권리신고
    table = parse_tenant_table(_pages("notice_pdf_texts_52802_2.json"))

    assert len(table.tenants) == 2
    assert table.rejected == 1  # 전입일·보증금이 모두 미상인 진짜 임차인 행 — 게이트 설계대로

    survey, claim = table.tenants
    assert survey.tenant_name == "이영희"
    assert survey.source_kind == "현황조사"
    assert survey.occupied_part == "공부상 505호(실제표시 605호)"
    assert survey.move_in_date == date(2002, 2, 2)
    assert survey.fixed_date is None  # 미상
    assert survey.deposit_amount is None  # 미상

    assert claim.source_kind == "권리신고"
    assert claim.occupied_part == "505호"
    assert claim.lease_period == "2002.02.01.~ 현재까지"
    assert claim.deposit_amount == 50_000_000
    assert claim.move_in_date == date(2002, 2, 2)
    assert claim.fixed_date == date(2002, 2, 19)
    assert claim.demanded_distribution is True
    assert claim.demanded_distribution_date == date(2022, 7, 13)


def test_corporate_name_wrapped_over_five_lines_stays_one_row():
    # 2022타경2593 물건1 — 법인 성명이 5줄로 감싸인 1행 문서 (마지막 조각까지 붙어야 한다)
    table = parse_tenant_table(_pages("notice_pdf_texts_2593_1.json"))

    assert table.rejected == 0
    (tenant,) = table.tenants
    assert tenant.tenant_name == "에이파이낸셜대부주식회사"
    assert tenant.source_kind == "등기사항전부증명서"
    assert tenant.occupied_part == "302호"
    assert tenant.possession_basis == "주거 전세권자"
    assert tenant.lease_period == "2022.5.12.~2024.5.11."
    assert tenant.deposit_amount == 5_000_000


def test_left_shifted_layout_gets_column_offset_correction():
    """표 전체가 왼쪽으로 ~9pt 밀린 변형 레이아웃 — 머리글 실측 x로 컬럼 경계를 보정한다.

    2025타경102642 물건1 실측(서울중앙, 2026-08-06). 고정 경계로는 각 컬럼의 첫 글자가 이전
    컬럼으로 새어 정보출처가 "리신고임"처럼 깨지고 전 행이 게이트에서 버려졌다 — 보증금
    2.9억도 앞자리 2가 새어 9천만으로 읽혔다. HUG 승계·임차권등기 사건이라 권리분석에
    가장 중요한 유형의 문서가 통째로 사라지는 경로였다.
    """
    table = parse_tenant_table(_pages("notice_pdf_texts_102642_1.json"))

    assert table.rejected == 0
    claim, registry = table.tenants
    assert claim.tenant_name == "주택도시보증공사"
    assert claim.source_kind == "권리신고"
    assert claim.occupied_part == "전부"
    assert claim.deposit_amount == 290_000_000
    assert claim.move_in_date == date(2022, 2, 23)
    assert claim.fixed_date == date(2022, 1, 25)
    assert claim.demanded_distribution is True
    assert registry.tenant_name == "정다운"
    assert registry.source_kind == "등기사항전부증명서"
    assert registry.deposit_amount == 290_000_000
    assert [t.tenant_seq for t in table.tenants] == [1, 2]


def test_commercial_wrapped_anchor_cell_does_not_split_rows():
    """상가 사건 — 전입신고일자 셀 "2023.10.31.(상가건물임대차현황서)"가 3줄로 감싸여도
    행이 쪼개지지 않는다.

    2025타경9542 물건1 실측(서울남부, 2026-08-06). 앵커 컬럼이 "한 줄"이라는 전제가 상가
    문서에서 깨졌고, 감싸임 조각과 다음 행 날짜 줄 사이(11pt)가 셀 안 줄 간격(12.5~13pt)보다
    좁아 간격 병합으로도 못 가른다 — 날짜 있는 줄만 행을 시작하는 규칙의 회귀 테스트.
    셀 값이 컬럼 상자보다 넓어 앞자리가 이웃 컬럼으로 새는 문제(run 중앙 배정)도 함께 덮는다.
    """
    table = parse_tenant_table(_pages("notice_pdf_texts_9542_1.json"))

    assert table.rejected == 0
    survey, claim = table.tenants
    assert survey.tenant_name == "한가을"
    assert survey.source_kind == "현황조사"
    assert survey.occupied_part == "1301호(31.5700㎡)"
    assert survey.deposit_amount == 7_000_000
    assert survey.monthly_rent == 700_000
    assert survey.move_in_date == date(2023, 10, 31)  # 사업자등록 신청일 (상가건물임대차현황서)
    assert survey.lease_period == "2023.10.31.~2025.10.30."
    assert claim.tenant_name is None  # 병합 셀 rowspan — 같은 사람의 권리신고 행
    assert claim.tenant_seq == survey.tenant_seq
    assert claim.source_kind == "권리신고"
    assert claim.demanded_distribution is True
    assert claim.demanded_distribution_date == date(2025, 7, 14)


def test_source_kind_with_trailing_text_passes_gate():
    """정보출처를 "현황조사 등"처럼 꼬리 붙여 적는 법원 — 시작 일치로 게이트를 통과해야 한다.

    2023타경5380 물건1 실측(서울북부, 2026-08-07). 완전일치 게이트가 이 표기를 깨진 행으로
    오판해 보증금 2억 행을 통째로 버렸다. 셀 5줄 감싸임(점유부분 3줄 + 정보출처 2줄)의
    단일 행 복원도 함께 덮는다.
    """
    table = parse_tenant_table(_pages("notice_pdf_texts_5380_1.json"))

    assert table.rejected == 0
    (tenant,) = table.tenants
    assert tenant.tenant_name == "이바다"
    assert tenant.source_kind == "현황조사등"
    assert tenant.occupied_part == "B101호202호203호"
    assert tenant.deposit_amount == 200_000_000
    assert tenant.monthly_rent == 2_000_000
    assert tenant.move_in_date == date(2018, 11, 8)
    assert tenant.fixed_date is None  # 미상
    assert tenant.lease_period == "2018.10.15.~2020.10.14."


@pytest.mark.parametrize("goods_seq", [1, 2, 3, 4])
def test_explicit_no_tenant_notice_is_empty_not_rejected(goods_seq):
    # 2022타경55450 — 표 안에 "조사된 임차내역없음" 한 줄만 렌더되는 빈 표.
    # 행이 아니므로 거부 카운트에도 넣지 않는다 (rejected>0을 파싱 불신 신호로 쓰기 위함)
    table = parse_tenant_table(_pages(f"notice_pdf_texts_55450_{goods_seq}.json"))

    assert table.tenants == ()
    assert table.rejected == 0


def test_returns_empty_when_header_absent():
    table = parse_tenant_table([[{"text": "부동산의 표시", "rect": [{"left": 1, "right": 2, "bottom": 3, "top": 4}]}]])

    assert table.tenants == ()


def test_ignores_malformed_lines():
    assert parse_tenant_table([[{"text": None}, "not-a-dict", {"rect": []}]]).tenants == ()


def test_parses_korean_amount_notation_of_old_cases():
    from collector.notice_tenant_parser import _parse_amount

    assert _parse_amount("230,000,000") == 230_000_000
    assert _parse_amount("천만원") == 10_000_000
    assert _parse_amount("1억 5천만원") == 150_000_000
    assert _parse_amount("2억원") == 200_000_000
    assert _parse_amount("미상") is None
    assert _parse_amount("보증금 없음") is None
    assert _parse_amount(None) is None


def test_unknown_fixed_date_becomes_null():
    from collector.notice_tenant_parser import _parse_date

    assert _parse_date("2021.06.04") == date(2021, 6, 4)
    assert _parse_date("미상") is None
    assert _parse_date("2021.13.40") is None
    assert _parse_date(None) is None


def test_rowspan_tenant_shares_one_seq():
    """같은 점유자가 정보출처별로 두 행에 걸치면 성명은 병합 셀에 한 번만 렌더된다.

    실측(52802-2): 현황조사 행에 성명이 있고 권리신고 행은 성명이 비어 있는데 같은 사람이다.
    행 순번을 그대로 쓰면 1명이 2명으로 세어져 H3(임차인 수)이 어긋난다 (WP-11 §4-8).
    """
    table = parse_tenant_table(_pages("notice_pdf_texts_52802_2.json"))

    assert len(table.tenants) >= 2
    named = [t for t in table.tenants if t.tenant_name is not None]
    nameless = [t for t in table.tenants if t.tenant_name is None]
    assert named and nameless, "이 픽스처는 rowspan 사례여야 한다"
    # 성명 없는 행은 직전 점유자의 순번을 잇는다 — 서로 다른 사람으로 갈리면 안 된다
    assert {t.tenant_seq for t in table.tenants} == {t.tenant_seq for t in named}


def test_distinct_named_tenants_get_distinct_seq():
    """서로 다른 성명은 각자 다른 순번을 받는다 — 연속 규칙이 다른 사람까지 묶으면 안 된다."""
    rows = [
        {"tenant_name": "김철수", "source_kind": "권리신고", "deposit_amount": "10,000,000"},
        {"tenant_name": None, "source_kind": "현황조사", "deposit_amount": "10,000,000"},
        {"tenant_name": "이영희", "source_kind": "권리신고", "deposit_amount": "20,000,000"},
    ]
    from collector.notice_tenant_parser import _to_tenants

    tenants = _to_tenants(rows)

    assert [t.tenant_seq for t in tenants] == [1, 1, 2]


def test_deposit_increase_does_not_split_a_tenant_into_fragment_rows():
    """보증금 증액 사건 — 한 셀에 금액이 여러 줄로 적혀도 임차인이 쪼개지지 않는다.

    2025타경908 물건1 실측. 예전에는 금액·확정일자를 행 기준선(anchor)으로 써서
    `1)190,000,000` / `2)200,000,000` 두 줄이 각각 가짜 행이 됐고, 쪼개진 조각은
    정보출처가 없어 버려지면서 보증금이 통째로 사라졌다.
    """
    table = parse_tenant_table(_pages("notice_pdf_texts_908_1.json"))

    # 정보출처가 온전해야 한다 — 쪼개지면 '등기사항전' / '부증명서'로 잘린다
    assert all(
        t.source_kind in ("현황조사", "권리신고", "등기사항전부증명서") for t in table.tenants
    )
    assert len(table.tenants) == 10

    # 증액 표기 두 형태가 모두 현재 보증금으로 읽혀야 한다
    deposits = [t.deposit_amount for t in table.tenants if t.deposit_amount is not None]
    assert deposits == [200_000_000, 200_000_000, 200_000_000, 210_000_000, 210_000_000, 10_000_000, 15_000_000]


def test_tenant_row_without_move_in_date_still_parses():
    """전세권자처럼 전입신고일자·배당요구여부가 없는 문서는 금액·확정일자로 행을 잡는다."""
    table = parse_tenant_table(_pages("notice_pdf_texts_2593_1.json"))

    (tenant,) = table.tenants
    assert tenant.move_in_date is None
    assert tenant.deposit_amount == 5_000_000


@pytest.mark.parametrize(
    ("cell", "expected"),
    [
        ("15,000,000", 15_000_000),
        # 순번 표기는 뒤 번호가 증액 후 현재 보증금이다 (줄이 붙어 와도 경계가 흐트러지면 안 된다)
        ("1)200,000,0002)210,000,000", 210_000_000),
        ("1)190,000,000 2)200,000,000", 200_000_000),
        # 괄호 앞이 현재 보증금이고 괄호 안은 증액 내역 — 괄호 안을 집으면 2.1억을 1천만으로 읽는다
        ("210,000,000(2022.6.1.10,000,000증액)", 210_000_000),
        ("200,000,000(2023.2.2. 10,000,000 증액)", 200_000_000),
        ("미상", None),
        ("", None),
        (None, None),
        # 구사건 한글 표기는 그대로 살아 있어야 한다
        ("1억5천만원", 150_000_000),
        # 콤마 없는 표기도 그대로 읽는다 (실측 4자리·8자리 셀)
        ("5000", 5_000),
        ("40000000", 40_000_000),
    ],
)
def test_parse_amount_handles_increase_notations(cell, expected):
    from collector.notice_tenant_parser import _parse_amount

    assert _parse_amount(cell) == expected


@pytest.mark.parametrize(
    ("cell", "expected"),
    [
        # 셀 안에서 줄바꿈된 금액 둘이 구분자 없이 붙는다 — 예전에는 18자리 수 하나로 읽었다
        ("220,000,000231,000,000", 220_000_000),
        ("300,000,000269,550,000", 300_000_000),
        # 행이 뭉쳐 세 셀이 붙은 경우 (실측 2025타경12316)
        ("40,000,00040,000,00040,000,000", 40_000_000),
        # 콤마가 없어 위 규칙으로 못 가르는 문자열은 상한으로 막고 버린다
        ("4000000040000000", None),
        ("400000004000000040000000", None),
    ],
)
def test_parse_amount_does_not_read_concatenated_cells_as_one_number(cell, expected):
    """어긋난 셀을 금액 하나로 읽으면 bigint를 넘겨 명세서 한 건이 통째로 저장 실패한다.

    실측 2026-08-18: `2025타경12316` 물건1이 두 실행 연속 `bigint out of range`로 저장되지
    못했다. 명세서는 기일이 지나면 다시 못 받으므로(WP-11 §4-3) 한 셀 때문에 문서를 잃으면
    복구 경로가 없다. DB에는 같은 원인으로 15~18자리 보증금 19행이 이미 들어가 있었다.
    """
    from collector.notice_tenant_parser import _parse_amount

    assert _parse_amount(cell) == expected


def test_deposit_tranches_split_increase_into_dated_shares():
    """증액 재계약은 확정일자별 몫으로 남긴다 — 원금과 증액분의 우선변제 순위가 다르다.

    명세서는 총액을 누적으로 적으므로(`1)2억 2)2.1억`) 차액으로 바꿔야 몫이 된다.
    """
    table = parse_tenant_table(_pages("notice_pdf_texts_908_1.json"))
    with_tranches = [t for t in table.tenants if t.deposit_tranches]

    # 증액 임차인 셋. 505호·503호는 등기와 권리신고 두 행 모두에 금액이 적혀 있고,
    # 501호는 권리신고 행에만 있다 (현황조사 행에는 보증금이 안 적혔다) → 2+2+1
    assert len(with_tranches) == 5
    for tenant in with_tranches:
        assert sum(tranche.amount for tranche in tenant.deposit_tranches) == tenant.deposit_amount

    seq_503 = [t for t in with_tranches if t.deposit_amount == 210_000_000]
    assert [(tr.amount, tr.fixed_date) for tr in seq_503[0].deposit_tranches] == [
        (200_000_000, date(2020, 6, 12)),
        (10_000_000, date(2022, 6, 3)),
    ]


def test_tenant_without_increase_has_no_tranches():
    """증액이 없으면 몫을 만들지 않는다 — 보증금 하나에 확정일자 하나면 나눌 게 없다."""
    table = parse_tenant_table([_page0()])

    assert all(t.deposit_tranches is None for t in table.tenants)


@pytest.mark.parametrize(
    ("deposit", "fixed", "expected"),
    [
        # 순번형 — 누적 총액을 차액으로 바꾼다
        (
            "1)200,000,0002)210,000,000",
            "1)2020.06.12.2)2022.06.03.",
            [(200_000_000, date(2020, 6, 12)), (10_000_000, date(2022, 6, 3))],
        ),
        # 괄호형 — 괄호 앞이 총액, 괄호 안이 증액분
        (
            "200,000,000(2023.2.2.10,000,000증액)",
            "1)2020.08.18.2)2023.03.02.",
            [(190_000_000, date(2020, 8, 18)), (10_000_000, date(2023, 3, 2))],
        ),
        # 확정일자가 하나뿐이면 나눌 근거가 없다
        ("1)200,000,0002)210,000,000", "2020.06.12.", None),
        # 누적이 줄어들면 우리가 아는 증액 형태가 아니다 — 추측하지 않는다
        ("1)210,000,0002)200,000,000", "1)2020.06.12.2)2022.06.03.", None),
        # 평범한 단일 보증금
        ("200,000,000", "2020.06.12.", None),
        (None, "1)2020.06.12.2)2022.06.03.", None),
    ],
)
def test_parse_deposit_tranches_only_when_unambiguous(deposit, fixed, expected):
    from collector.notice_tenant_parser import _parse_deposit_tranches

    result = _parse_deposit_tranches(deposit, fixed)

    if expected is None:
        assert result is None
    else:
        assert [(tr.amount, tr.fixed_date) for tr in result] == expected


# --- 표 영역 원문 보관 (017, WP-11 §4-27·§4-29) ---

_TENANT_FIXTURES = [
    "notice_pdf_texts_page0.json",
    "notice_pdf_texts_52802_2.json",
    "notice_pdf_texts_2593_1.json",
    "notice_pdf_texts_102642_1.json",
    "notice_pdf_texts_9542_1.json",
    "notice_pdf_texts_5380_1.json",
    "notice_pdf_texts_908_1.json",
]


@pytest.mark.parametrize("name", _TENANT_FIXTURES)
def test_tenant_text_region_reparses_to_same_tenants(name):
    """보관한 영역 원문만 다시 넣어도 같은 점유자가 나와야 한다.

    이게 017의 존재 이유다 — 열람 창이 닫힌 뒤에도 파서를 고쳐 다시 파싱하려면, 보관한 값이
    parse_tenant_table의 입력으로 그대로 쓰일 수 있어야 한다 (머리글 포함).
    """
    table = parse_tenant_table(_pages(name))
    assert table.region_lines, "표를 찾았으면 영역 원문도 남아야 한다"

    reparsed = parse_tenant_table([list(page) for page in table.region_lines])

    assert reparsed.tenants == table.tenants
    assert reparsed.rejected == table.rejected


@pytest.mark.parametrize("name", _TENANT_FIXTURES)
def test_tenant_text_region_excludes_free_text(name):
    """영역 원문에 자유서술 3란(비고·인수권리·지상권)이 섞이지 않아야 한다 (A-08).

    ItemNotice가 자유서술 원문을 저장하지 않기로 한 결정(006)은 그 란에 신고인·가등기권자
    실명이 마스킹 없이 실리기 때문이다. 017이 표 영역만 담는다는 것을 실제 문서로 못박는다 —
    페이지 전체를 담도록 되돌리면 여기서 실패한다.
    """
    table = parse_tenant_table(_pages(name))
    text = "".join(
        line.get("text", "") for page in table.region_lines for line in page
    )

    for marker in ("<비고>", "비고란", "지상권", "매수인에게 대항할"):
        assert marker not in text, f"{marker}가 영역 원문에 들어왔다"


def test_tenant_text_region_is_empty_when_table_not_found():
    """표를 못 찾으면 원문도 남기지 않는다 — 엉뚱한 페이지를 통째로 저장하지 않게."""
    table = parse_tenant_table([[{"text": "부동산의 표시", "rect": [{"left": 1, "right": 2, "bottom": 3, "top": 4}]}]])
    assert table.region_lines == ()
