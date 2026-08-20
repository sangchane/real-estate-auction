# 매각물건명세서 파서 단위 테스트 — 최선순위 설정 표기 변형·항목 누락·구조화 판정·원문 미저장 검증
import json
from dataclasses import fields
from datetime import date
from pathlib import Path

import pytest

from collector.court_parser import ItemNotice, parse_item_notice


FIXTURE = Path(__file__).parent / "fixtures" / "court_item_detail_page.json"


def _load() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def _parse(payload: dict) -> ItemNotice | None:
    return parse_item_notice(
        payload,
        court_office_code="B000210",
        case_no="2022타경101244",
        item_no="1",
    )


def _parse_free_text(
    assumed_rights: str | None = None,
    superficies: str | None = None,
    remarks: str | None = None,
) -> ItemNotice:
    """자유서술 3란만 바꿔 파싱한다 — 구조화 판정 테스트용."""
    payload = _load()
    dxdy = payload["data"]["dma_result"]["dspslGdsDxdyInfo"]
    dxdy["ndstrcRghCtt"] = assumed_rights
    dxdy["sprfcExstcDts"] = superficies
    dxdy["gdsSpcfcRmk"] = remarks
    notice = _parse(payload)
    assert notice is not None
    return notice


def test_parse_item_notice_maps_all_present_fields():
    notice = _parse(_load())

    assert notice is not None
    assert notice.court_office_code == "B000210"
    assert notice.case_no == "2022타경101244"
    assert notice.item_no == "1"
    assert notice.document_date == date(2026, 7, 3)
    assert notice.distribution_demand_deadline == date(2025, 3, 10)
    # 토지와 집합건물의 최선순위를 따로 적는 사건 — 원문을 그대로 두고 가장 이른 날짜를 고른다
    assert notice.baseline_raw is not None
    assert "집합건물" in notice.baseline_raw
    assert notice.baseline_date == date(2003, 5, 23)
    # 비고: "-토지 별도등기 있음(가등기, 근저당권)\n-유치권 신고 있으나 성립여부 불분명함"
    assert notice.risk_flags == ["LAND_SEPARATE_REGISTRATION", "LIEN_CLAIM"]
    assert notice.lien_claim_amount is None  # 금액 표기 없음
    # 인수권리 란이 공란이면 NULL — 미작성이므로 NONE(명시적 판단)과 구분한다
    assert notice.assumed_rights_kind is None


def test_parse_item_notice_reads_dotted_and_padded_date_formats():
    payload = _load()
    dxdy = payload["data"]["dma_result"]["dspslGdsDxdyInfo"]
    dxdy["tprtyRnkHypthcStngDts"] = "2024.12.11. 경매개시결정\n2022.1.12.압류"

    notice = _parse(payload)

    assert notice is not None
    assert notice.baseline_date == date(2022, 1, 12)


def test_parse_item_notice_keeps_baseline_raw_when_date_is_unparsable():
    payload = _load()
    dxdy = payload["data"]["dma_result"]["dspslGdsDxdyInfo"]
    dxdy["tprtyRnkHypthcStngDts"] = "최선순위 설정일자 미상"

    notice = _parse(payload)

    assert notice is not None
    assert notice.baseline_raw == "최선순위 설정일자 미상"
    assert notice.baseline_date is None


def test_parse_item_notice_ignores_impossible_date_in_baseline():
    payload = _load()
    dxdy = payload["data"]["dma_result"]["dspslGdsDxdyInfo"]
    dxdy["tprtyRnkHypthcStngDts"] = "2024.02.31. 근저당권\n2024.03.01. 압류"

    notice = _parse(payload)

    assert notice is not None
    assert notice.baseline_date == date(2024, 3, 1)


def test_parse_item_notice_survives_missing_optional_blocks():
    payload = _load()
    del payload["data"]["dma_result"]["dstrtDemnInfo"]
    payload["data"]["dma_result"]["dspslGdsDxdyInfo"]["gdsSpcfcRmk"] = "   "

    notice = _parse(payload)

    assert notice is not None
    assert notice.distribution_demand_deadline is None
    assert notice.risk_flags == []
    assert notice.lien_claim_amount is None
    assert notice.document_date == date(2026, 7, 3)


def test_parse_item_notice_returns_none_when_notice_not_written_yet():
    payload = _load()
    dxdy = payload["data"]["dma_result"]["dspslGdsDxdyInfo"]
    dxdy["gdsSpcfcWrtYmd"] = None
    dxdy["tprtyRnkHypthcStngDts"] = None

    assert _parse(payload) is None


def test_parse_item_notice_returns_none_for_broken_payload():
    assert _parse({"status": 200, "data": {"ipcheck": True}}) is None
    assert _parse({}) is None
    assert _parse({"data": {"dma_result": []}}) is None


def test_item_notice_stores_no_free_text():
    """자유서술 원문(비고·인수권리·지상권)을 담는 필드가 아예 없어야 한다.

    필드 집합 자체를 고정한다 — 원문 필드가 다시 생기면 실패한다. 정규식 마스킹이
    양방향으로 실패해 원문을 버린 결정(마이그레이션 006)을 코드로 못박는 검사다.
    점유자 성명은 여기가 아니라 점유자 표(NoticeTenant)에 저장한다.
    """
    field_names = {field.name for field in fields(ItemNotice)}

    assert field_names == {
        "court_office_code",
        "case_no",
        "item_no",
        "document_date",
        "baseline_raw",
        "baseline_date",
        "distribution_demand_deadline",
        "assumed_rights_kind",
        "risk_flags",
        "lien_claim_amount",
        "tenants",
        "tenants_scanned",
        "tenants_rejected",
        # 표가 다음 쪽으로 이어졌는지 — boolean이라 자유서술 원문이 아니다 (WP-11 §4-26)
        "tenants_continued",
        "bid_date",
        # 점유자 표 **영역만**의 텍스트 레이어 원문 (017). 자유서술 3란은 표 아래 <비고>부터라
        # 이 영역에 들어오지 않는다 — 아래 test_tenant_text_region_excludes_free_text가
        # 실제 문서로 그 경계를 검사한다
        "tenant_text_region",
    }


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("해당사항없음", "NONE"),
        ("을구 순위 1번 주택임차권등기", "LEASEHOLD_REGISTRATION"),
        ("을구 순위1번 주택임차권등기", "LEASEHOLD_REGISTRATION"),
        ("을구 1번 주택임차권등기", "LEASEHOLD_REGISTRATION"),
        ("을구1번 주택임차권 등기", "LEASEHOLD_REGISTRATION"),
        (
            "2023.04.21.접수 제54618호로 경료된 을구 1번 주택임차권등기는 배당에서 "
            "보증금 전액 배당받지 않으면 잔액을 매수인이 인수함",
            "LEASEHOLD_REGISTRATION",
        ),
        (
            "토지 을구 1번 지상권설정등기(1993.7.19.접수 제84730호)는 말소되지 않고 "
            "매수인에게 인수됨",
            "SUPERFICIES",
        ),
        (
            "갑구 순위 3번 소유권이전등기청구권 가등기: 매매예약에 따른 순위보전 가등기",
            "PROVISIONAL_REGISTRATION",
        ),
        ("매수인에게 인수되는 권리 있음 여부는 등기부 확인 요망", "OTHER"),
    ],
)
def test_assumed_rights_kind_from_observed_texts(raw, expected):
    """실측된 인수권리 란 원문이 표대로 판정돼야 한다."""
    assert _parse_free_text(assumed_rights=raw).assumed_rights_kind == expected


def test_assumed_rights_kind_is_null_when_blank():
    """공란(미작성)은 NULL — 법원의 명시적 판단인 NONE과 구분한다."""
    assert _parse_free_text(assumed_rights=None).assumed_rights_kind is None
    assert _parse_free_text(assumed_rights="   ").assumed_rights_kind is None


def test_assumed_rights_kind_priority_provisional_over_leasehold_over_superficies():
    """가등기(소유권 상실 위험) > 주택임차권등기 > 지상권 순으로 판정한다."""
    both = "을구 1번 주택임차권등기 및 갑구 3번 소유권이전등기청구권 가등기 인수"
    assert _parse_free_text(assumed_rights=both).assumed_rights_kind == "PROVISIONAL_REGISTRATION"

    lease_and_superficies = "을구 1번 주택임차권등기 및 토지 을구 1번 지상권설정등기 인수"
    assert (
        _parse_free_text(assumed_rights=lease_and_superficies).assumed_rights_kind
        == "LEASEHOLD_REGISTRATION"
    )


def test_hug_priority_waiver_requires_both_conditions():
    """HUG 플래그는 공사 이름과 대항력 포기 문구가 모두 있어야 선다."""
    observed = (
        "주택도시보증공사 : 우선변제권만 주장하고 대항력을 포기하며, 배당금으로 "
        "임대차보증금반환채권을 전액받지 못하더라도 매수인에 대한 잔존 임대차보증금 "
        "반환청구권을 포기하고 임차권등기말소에 동의한다는 대항력포기확약서를 제출(2024.12.04.)"
    )
    assert "HUG_PRIORITY_WAIVER" in _parse_free_text(remarks=observed).risk_flags
    # 변형 표기 "대항력은 포기"도 인정한다
    assert (
        "HUG_PRIORITY_WAIVER"
        in _parse_free_text(remarks="주택도시보증공사가 대항력은 포기함").risk_flags
    )
    # 한쪽만 있으면 서지 않는다
    assert _parse_free_text(remarks="주택도시보증공사 배당요구 있음").risk_flags == []
    assert _parse_free_text(remarks="임차인이 대항력을 포기함").risk_flags == []


@pytest.mark.parametrize(
    ("raw", "expected_flag"),
    [
        (
            "-2008.11.28. ○○○ 유치권신고(879,596,895원)하였으나, 성립여부 불분명함",
            "LIEN_CLAIM",
        ),
        ("공유자우선매수신고는 1회에 한함", "PREEMPTIVE_PURCHASE"),
        (
            "배당요구종기일 기준으로 임차권보다 앞선 선순위 조세가 있으므로 이를 감안하여 입찰요함",
            "SENIOR_TAX",
        ),
        ("가등기된 매매예약이 완결되는 경우 매수인이 소유권을 상실하게 됨", "TITLE_LOSS_RISK"),
        ("-재매각임: 매수신청보증금 20%", "RESALE"),
        ("-토지 별도등기 있음(가등기, 근저당권)", "LAND_SEPARATE_REGISTRATION"),
        (
            "-건축법상 사용승인 받지 않은 장기미준공 건물(사전입주 및 5층 무단증축으로 인해)로서 "
            "집합건축물대장이 없음.",
            "UNAUTHORIZED_EXTENSION",
        ),
        (
            "-개시결정 당시에는 대지권 미등기이나, 이후 대지권등기가 완료되어 이를 포함하여 매각함",
            "SITE_RIGHT_UNREGISTERED",
        ),
        ("-102호 누수 있음", "WATER_LEAK"),
    ],
)
def test_risk_flags_from_observed_remarks(raw, expected_flag):
    """실측된 비고란 원문마다 해당 코드가 선다."""
    assert expected_flag in _parse_free_text(remarks=raw).risk_flags


def test_risk_flags_combine_all_three_fields_sorted_without_duplicates():
    """3란(인수권리·지상권·비고)을 합쳐 검사하고, 결과는 정렬된 중복 없는 리스트다."""
    notice = _parse_free_text(
        assumed_rights="토지 을구 1번 지상권설정등기는 말소되지 않고 매수인에게 인수됨",
        superficies="법정지상권 성립 여지 있음",
        remarks="-재매각임: 매수신청보증금 20%\n-102호 누수 있음\n-유치권신고 있음\n-유치권 신고 2건",
    )

    assert notice.risk_flags == ["LIEN_CLAIM", "RESALE", "WATER_LEAK"]
    assert notice.risk_flags == sorted(set(notice.risk_flags))


def test_lien_claim_amount_parsed_from_observed_remark():
    """유치권신고(879,596,895원) 표기에서 콤마 제거 후 정수로 뽑는다."""
    observed = "-2008.11.28. ○○○ 유치권신고(879,596,895원)하였으나, 성립여부 불분명함"

    notice = _parse_free_text(remarks=observed)

    assert notice.lien_claim_amount == 879_596_895
    assert "LIEN_CLAIM" in notice.risk_flags


def test_lien_claim_amount_is_null_without_amount():
    notice = _parse_free_text(remarks="-유치권 신고 있으나 성립여부 불분명함")

    assert notice.lien_claim_amount is None
    assert "LIEN_CLAIM" in notice.risk_flags
