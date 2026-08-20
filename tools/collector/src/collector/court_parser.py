from __future__ import annotations

import base64
import binascii
import re
from dataclasses import dataclass, replace
from datetime import date
from typing import Any

from collector.geo import katec_to_wgs84
from collector.notice_tenant_parser import NoticeTenant


class CourtPayloadError(ValueError):
    """법원 응답이 수집기가 기대하는 최소 필드 계약을 만족하지 않을 때 발생한다."""


@dataclass(frozen=True)
class AuctionItem:
    court_office_code: str
    case_no: str
    item_no: str
    court_name: str | None
    usage_code: str | None
    address: str | None
    appraisal_amount: int | None
    minimum_sale_price: int | None
    failed_bid_count: int | None
    bid_datetime: str | None
    location: tuple[float, float] | None
    raw: dict[str, Any]

    @property
    def natural_key(self) -> tuple[str, str, str]:
        return (self.court_office_code, self.case_no, self.item_no)

    def with_updates(self, **changes: Any) -> AuctionItem:
        return replace(self, **changes)


@dataclass(frozen=True)
class SearchPage:
    total_count: int
    page_no: int
    items: list[AuctionItem]


def parse_search_page(payload: dict[str, Any]) -> SearchPage:
    data = _object_at(payload, "data")
    page_info = _object_at(data, "dma_pageInfo")
    rows = _list_at(data, "dlt_srchResult")
    return SearchPage(
        total_count=_optional_int(page_info.get("totalCnt")) or 0,
        page_no=_optional_int(page_info.get("pageNo")) or 1,
        items=[_parse_item(row, index) for index, row in enumerate(rows)],
    )


def _parse_item(row: Any, index: int) -> AuctionItem:
    if not isinstance(row, dict):
        raise CourtPayloadError(f"items[{index}] must be an object")

    court_office_code = _required_str(row, "boCd")
    case_no = _required_str(row, "srnSaNo")
    item_no = _required_str(row, "mokmulSer")
    x = _optional_float(row.get("xCordi"))
    y = _optional_float(row.get("yCordi"))

    return AuctionItem(
        court_office_code=court_office_code,
        case_no=case_no,
        item_no=item_no,
        court_name=_optional_str(row.get("jiwonNm")),
        usage_code=_optional_str(row.get("sclsUtilCd")),
        address=_optional_str(row.get("printSt")),
        appraisal_amount=_optional_int(row.get("gamevalAmt")),
        minimum_sale_price=_optional_int(row.get("minmaePrice")),
        failed_bid_count=_optional_int(row.get("yuchalCnt")),
        bid_datetime=_combine_bid_datetime(row),
        location=katec_to_wgs84(x, y) if x is not None and y is not None else None,
        raw=dict(row),
    )


# 수집 출처 코드 — auction_sale_result.source 컬럼 값
SOURCE_SCHEDULE_RESULT_SEARCH = "SCHEDULE_RESULT_SEARCH"
SOURCE_CASE_SEARCH = "CASE_SEARCH"

# 매각결과검색 mulStatcd → 기일 결과코드(LJH-AUCTN_DXDY_RSLT_CD) 대응 (04=매각→001, 03=유찰→002)
_MUL_STAT_TO_RESULT_CODE = {"04": "001", "03": "002"}


@dataclass(frozen=True)
class SaleResult:
    """auction_sale_result 한 행에 해당하는 기일 결과 관측값."""

    court_office_code: str
    case_no: str
    item_no: str
    dxdy_date: date
    dxdy_kind_code: str
    result_code: str
    sale_amount: int | None
    minimum_sale_price: int | None
    failed_bid_count: int | None
    source: str


@dataclass(frozen=True)
class SaleResultPage:
    total_count: int
    page_no: int
    results: list[SaleResult]


def parse_sale_result_page(payload: dict[str, Any]) -> SaleResultPage:
    """매각결과검색(PGJ158M00) 응답을 매각 결과 행으로 변환한다.

    결과가 아닌 행(진행 중 등)과 필드가 깨진 행은 그 행만 건너뛴다 — 전체 실패로 만들지 않는다.
    """
    data = _object_at(payload, "data")
    page_info = _object_at(data, "dma_pageInfo")
    results = []
    for row in _list_at(data, "dlt_srchResult"):
        parsed = _parse_sale_result_row(row)
        if parsed is not None:
            results.append(parsed)
    return SaleResultPage(
        total_count=_optional_int(page_info.get("totalCnt")) or 0,
        page_no=_optional_int(page_info.get("pageNo")) or 1,
        results=results,
    )


def _parse_sale_result_row(row: Any) -> SaleResult | None:
    if not isinstance(row, dict):
        return None
    try:
        result_code = _MUL_STAT_TO_RESULT_CODE.get(_optional_str(row.get("mulStatcd")) or "")
        court_office_code = _optional_str(row.get("boCd"))
        case_no = _optional_str(row.get("srnSaNo"))
        item_no = _optional_str(row.get("mokmulSer"))
        dxdy_date = _date_from_yyyymmdd(row.get("maeGiil"))
        if None in (result_code, court_office_code, case_no, item_no, dxdy_date):
            return None
        return SaleResult(
            court_office_code=court_office_code,
            case_no=case_no,
            item_no=item_no,
            dxdy_date=dxdy_date,
            dxdy_kind_code="01",  # 매각결과검색 행은 매각기일 결과다
            result_code=result_code,
            sale_amount=_amount_or_none(row.get("maeAmt")),
            minimum_sale_price=_amount_or_none(row.get("minmaePrice")),
            failed_bid_count=_optional_int(row.get("yuchalCnt")),
            source=SOURCE_SCHEDULE_RESULT_SEARCH,
        )
    except CourtPayloadError:
        return None


def parse_case_sale_results(
    payload: dict[str, Any],
    *,
    court_office_code: str,
    case_no: str,
) -> list[SaleResult]:
    """경매사건검색(PGJ159M00) 응답의 기일내역을 매각 결과 행으로 변환한다.

    종국 사건 등으로 사건 기본정보가 없으면 빈 목록을 돌려준다.
    기일 행의 dspslGdsSeq(물건번호)는 물건별 목록의 dspslObjctSeq(목적물번호=우리 item_no)로
    바꿔 매핑한다 — 실측: 2024타경109389에서 물건 2번=목적물 3번으로 두 체계가 갈라진다.
    """
    data = payload.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("dma_csBasInf"), dict):
        return []

    goods_by_seq: dict[str, list[dict[str, Any]]] = {}
    goods_list = data.get("dlt_dspslGdsDspslObjctLst")
    for entry in goods_list if isinstance(goods_list, list) else []:
        if not isinstance(entry, dict):
            continue
        seq = _optional_str(entry.get("dspslGdsSeq"))
        if seq is not None:
            goods_by_seq.setdefault(seq, []).append(entry)

    results = []
    dxdy_list = data.get("dlt_rletCsGdsDtsDxdyInf")
    for row in dxdy_list if isinstance(dxdy_list, list) else []:
        results.extend(
            _parse_case_dxdy_row(
                row, goods_by_seq, court_office_code=court_office_code, case_no=case_no
            )
        )
    return results


def _parse_case_dxdy_row(
    row: Any,
    goods_by_seq: dict[str, list[dict[str, Any]]],
    *,
    court_office_code: str,
    case_no: str,
) -> list[SaleResult]:
    if not isinstance(row, dict):
        return []
    try:
        kind_code = _optional_str(row.get("auctnDxdyKndCd"))
        result_code = _optional_str(row.get("auctnDxdyRsltCd"))  # 결과 없는 미래 기일은 스킵
        dxdy_ymd = _optional_str(row.get("dxdyYmd"))
        dxdy_date = _date_from_yyyymmdd(dxdy_ymd)
        goods_seq = _optional_str(row.get("dspslGdsSeq"))
        if None in (kind_code, result_code, dxdy_date, goods_seq):
            return []

        results = []
        for goods in goods_by_seq.get(goods_seq, []):
            item_no = _optional_str(goods.get("dspslObjctSeq"))
            if item_no is None:
                continue
            # 물건별 목록의 낙찰가·최저가는 현재 공고의 매각기일(dspslDxdyYmd) 것만 신뢰한다
            same_dxdy = _optional_str(goods.get("dspslDxdyYmd")) == dxdy_ymd
            results.append(
                SaleResult(
                    court_office_code=court_office_code,
                    case_no=case_no,
                    item_no=item_no,
                    dxdy_date=dxdy_date,
                    dxdy_kind_code=kind_code,
                    result_code=result_code,
                    sale_amount=(
                        _amount_or_none(goods.get("dspslAmt"))
                        if kind_code == "01" and same_dxdy
                        else None
                    ),
                    minimum_sale_price=(
                        _amount_or_none(goods.get("fstPbancLwsDspslPrc")) if same_dxdy else None
                    ),
                    failed_bid_count=None,  # 사건검색은 유찰 횟수를 제공하지 않는다
                    source=SOURCE_CASE_SEARCH,
                )
            )
        return results
    except CourtPayloadError:
        return []


@dataclass(frozen=True)
class ItemNotice:
    """auction_item_notice 한 행에 해당하는 매각물건명세서 기재사항.

    개인정보(A-08): 자유서술 3란(인수권리·지상권·비고)에는 신고인·가등기권자 실명이 마스킹
    없이 실린다. 정규식 마스킹은 실측에서 양방향으로 실패해(006 마이그레이션 주석 참조)
    원문을 아예 저장하지 않는다 — 키워드 판정을 메모리에서만 하고 구조화 결과 3개
    (assumed_rights_kind, risk_flags, lien_claim_amount)만 남긴다.
    """

    court_office_code: str
    case_no: str
    item_no: str
    document_date: date | None
    baseline_raw: str | None
    baseline_date: date | None
    distribution_demand_deadline: date | None
    assumed_rights_kind: str | None
    risk_flags: list[str]
    lien_claim_amount: int | None
    # 점유자(임차인) 표는 명세서 PDF에만 있어 별도 경로로 받는다 — 열람 창(기일 1주 전~기일) 밖에서는
    # 비어 있다. JSON 기재사항만 수집할 때는 이 필드를 채우지 않는다
    tenants: tuple[NoticeTenant, ...] = ()
    # PDF를 실제로 열어 표 파싱까지 끝냈는지 — 표가 비어 있어도(법원이 임차인 없다고 적은 문서) True다.
    # tenants가 비었다는 사실만으로는 "못 열었다"와 "열었더니 없다"를 구분할 수 없다
    tenants_scanned: bool = False
    # 검증 게이트가 버린 행 수 (WP-11 §4-7). tenants가 비었어도 이 값이 >0이면 "임차인 없음"이
    # 아니라 "행이 있었는데 버림"이다 — H3는 그 물건을 표본에서 빼야 한다. None = 스캔 전이라 모름
    tenants_rejected: int | None = None
    # 점유자 표가 다음 쪽으로 이어졌는지. true면 표가 불완전할 수 있어 "권리신고 행이 없다"를
    # 근거로 쓸 수 없다 — 파서는 계산했는데 저장하지 않아 이 구분이 사라졌다 (WP-11 §4-26).
    # None = 문서를 열지 못해 모름
    tenants_continued: bool | None = None
    # 이 명세서가 어느 매각기일 것인지. 명세서는 기일마다 새로 작성되므로, 이게 없으면
    # 유찰 후 새 기일의 명세서를 받아야 하는지 판단할 수 없다 (WP-11 §4-13)
    bid_date: date | None = None
    # 점유자 표 영역의 텍스트 레이어 원문(쪽별 라인). 파서를 고친 뒤 재수집 없이 다시 파싱하려고
    # 남긴다 (017). 위 A-08 주석대로 **표 영역만** 담는다 — 자유서술 3란은 넣지 않는다.
    # None = 문서를 열지 못해 모름
    tenant_text_region: tuple[tuple[Any, ...], ...] | None = None


# 최선순위 설정 원문의 날짜 표기 — "2008.07.09", "2022.1.12.", "2024. 12. 11." 모두 실측된 형태다
_BASELINE_DATE_PATTERN = re.compile(r"(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})")

# 인수권리 란 키워드 → 판정값. 한 서술에 여러 권리가 같이 적힐 수 있어 심각한 순서로 먼저
# 판정한다 — 가등기(소유권 상실 위험) > 주택임차권등기 > 지상권. "주택임차권 등기"처럼
# 띄어쓰기 변형이 실측돼 키워드 안 공백만 허용한다.
_ASSUMED_RIGHTS_PATTERNS = (
    (re.compile("가등기"), "PROVISIONAL_REGISTRATION"),
    (re.compile(r"주택임차권\s*등기"), "LEASEHOLD_REGISTRATION"),
    (re.compile("지상권"), "SUPERFICIES"),
)

# risk_flags 코드 → 판정 키워드(하나라도 있으면 해당). 비고·인수권리·지상권 3란을 합쳐 검사한다.
# HUG_PRIORITY_WAIVER는 두 조건이 동시에 필요해 별도 처리한다.
_RISK_FLAG_KEYWORDS = (
    ("LIEN_CLAIM", ("유치권신고", "유치권 신고")),
    ("PREEMPTIVE_PURCHASE", ("우선매수",)),
    ("SENIOR_TAX", ("선순위 조세",)),
    ("TITLE_LOSS_RISK", ("소유권을 상실",)),
    ("RESALE", ("재매각",)),
    ("LAND_SEPARATE_REGISTRATION", ("별도등기",)),
    ("UNAUTHORIZED_EXTENSION", ("무단증축", "미준공")),
    ("SITE_RIGHT_UNREGISTERED", ("대지권 미등기",)),
    ("WATER_LEAK", ("누수",)),
)

# 유치권 신고액 표기 — 실측: "유치권신고(879,596,895원)"
_LIEN_AMOUNT_PATTERN = re.compile(r"유치권\s*신고\s*\(\s*([0-9][0-9,]*)\s*원")


def _classify_assumed_rights(text: str | None) -> str | None:
    """인수권리 란 서술을 유형 코드로 판정한다.

    공란(None)은 미작성이므로 None, "해당사항없음"은 법원의 명시적 판단이므로 NONE —
    둘을 구분한다. 실측상 "해당사항없음"은 단독으로만 나오므로 최우선으로 확정한다.
    """
    if text is None:
        return None
    if "해당사항없음" in text:
        return "NONE"
    for pattern, kind in _ASSUMED_RIGHTS_PATTERNS:
        if pattern.search(text):
            return kind
    return "OTHER"


def _detect_risk_flags(combined: str) -> list[str]:
    """합쳐진 자유서술에서 위험·조건 신호 코드를 뽑는다 — 정렬된 중복 없는 리스트."""
    flags = set()
    # HUG 대항력 포기: 공사 이름과 포기 문구가 모두 있어야 한다 — 이름만으로는 알 수 없다
    if "주택도시보증공사" in combined and (
        "대항력을 포기" in combined or "대항력은 포기" in combined
    ):
        flags.add("HUG_PRIORITY_WAIVER")
    for code, keywords in _RISK_FLAG_KEYWORDS:
        if any(keyword in combined for keyword in keywords):
            flags.add(code)
    return sorted(flags)


def _parse_lien_claim_amount(combined: str) -> int | None:
    """유치권 신고액을 뽑는다. 금액 표기가 없으면 None."""
    match = _LIEN_AMOUNT_PATTERN.search(combined)
    return int(match.group(1).replace(",", "")) if match else None


def parse_item_notice(
    payload: dict[str, Any],
    *,
    court_office_code: str,
    case_no: str,
    item_no: str,
) -> ItemNotice | None:
    """물건상세(PGJ15BM01) 응답에서 매각물건명세서 기재사항을 뽑는다.

    항목이 없으면 그 필드만 None으로 두고 전체를 실패시키지 않는다. 명세서 자체가 아직
    작성되지 않은 물건(작성일 없음)이면 None을 돌려준다.
    """
    data = payload.get("data")
    if not isinstance(data, dict):
        return None
    result = data.get("dma_result")
    if not isinstance(result, dict):
        return None
    dxdy = result.get("dspslGdsDxdyInfo")
    if not isinstance(dxdy, dict):
        return None

    document_date = _date_from_yyyymmdd(dxdy.get("gdsSpcfcWrtYmd"))
    baseline_raw = _optional_str(dxdy.get("tprtyRnkHypthcStngDts"))
    if document_date is None and baseline_raw is None:
        return None

    # 자유서술 3란은 실명이 실릴 수 있어 어떤 필드에도 담지 않는다 (A-08).
    # 여기서 메모리로만 읽어 키워드 판정 결과만 남긴다.
    assumed_rights_text = _optional_str(dxdy.get("ndstrcRghCtt"))
    free_texts = (
        assumed_rights_text,
        _optional_str(dxdy.get("sprfcExstcDts")),
        _optional_str(dxdy.get("gdsSpcfcRmk")),
    )
    combined = "\n".join(text for text in free_texts if text is not None)

    return ItemNotice(
        court_office_code=court_office_code,
        case_no=case_no,
        item_no=item_no,
        document_date=document_date,
        baseline_raw=baseline_raw,
        baseline_date=_baseline_date(baseline_raw),
        distribution_demand_deadline=_distribution_demand_deadline(result),
        assumed_rights_kind=_classify_assumed_rights(assumed_rights_text),
        risk_flags=_detect_risk_flags(combined),
        lien_claim_amount=_parse_lien_claim_amount(combined),
    )


def _baseline_date(baseline_raw: str | None) -> date | None:
    """최선순위 설정 원문에서 가장 이른 날짜를 고른다.

    토지와 집합건물의 최선순위를 따로 적는 사건이 있어 날짜가 여러 개다. 말소기준은 그중
    가장 이른 날짜다.
    """
    if baseline_raw is None:
        return None
    parsed = []
    for year, month, day in _BASELINE_DATE_PATTERN.findall(baseline_raw):
        try:
            parsed.append(date(int(year), int(month), int(day)))
        except ValueError:
            continue
    return min(parsed) if parsed else None


def _distribution_demand_deadline(result: dict[str, Any]) -> date | None:
    entries = result.get("dstrtDemnInfo")
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        deadline = _date_from_yyyymmdd(entry.get("dstrtDemnLstprdYmd"))
        if deadline is not None:
            return deadline
    return None


# auction_case_photo.source 값 — 사진출처 구분코드(auctnInfOriginDvsCd) 실측: "2"=현황조사(집행관),
# "4"=감정평가. 감정평가 출처만 APPRAISAL로, 나머지는 물건 사진(ITEM)으로 둔다.
PHOTO_SOURCE_ITEM = "ITEM"
PHOTO_SOURCE_APPRAISAL = "APPRAISAL"
_APPRAISAL_ORIGIN_CODE = "4"

# 이미지 형식은 매직 바이트로 판별한다 — 실측: 확장자가 .jpg여도 실제 바이트는 GIF인 사진이 있다
_IMAGE_MAGIC_TYPES = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF8", "image/gif"),
    (b"\x89PNG", "image/png"),
)


@dataclass(frozen=True)
class CasePhoto:
    """auction_case_photo 한 행에 해당하는 사진 관측값.

    법원 사진 API는 사건 단위이고 메타에 물건번호가 없다 — 물건 단위로 저장하면 다물건 사건이
    복제된다(WP-12). 사진 구분(위치도·전경 등)은 화면 정렬·묶음에 쓴다.
    """

    court_office_code: str
    case_no: str
    seq: int
    source: str
    category_code: str | None
    category_name: str | None
    url: str | None
    caption: str | None
    content_type: str | None
    image: bytes


@dataclass(frozen=True)
class PhotoPage:
    total_count: int
    page_no: int
    photos: list[CasePhoto]


def _photo_category_names(data: dict[str, Any]) -> dict[str, str]:
    """사진 구분 코드 → 이름 (dlt_csPicDvsCnt에만 이름이 있다)."""
    names: dict[str, str] = {}
    for entry in _list_at(data, "dlt_csPicDvsCnt"):
        if not isinstance(entry, dict):
            continue
        code = _optional_str(entry.get("cortAuctnPicDvsCd"))
        name = _optional_str(entry.get("cortAuctnPicDvsNm"))
        if code is not None and name is not None:
            names[code] = name
    return names


def parse_photo_page(
    payload: dict[str, Any],
    *,
    court_office_code: str,
    case_no: str,
) -> PhotoPage:
    """사진조회(selectPicInf) 응답을 사진 행으로 변환한다.

    메타(dlt_csPicLst)와 바이트(picLst)는 같은 순서의 병렬 배열이다. base64가 깨진 행 등
    변환할 수 없는 행은 그 행만 건너뛴다 — 전체 실패로 만들지 않는다.
    """
    data = _object_at(payload, "data")
    page_info = _object_at(data, "dma_pageInfo")
    rows = _list_at(data, "dlt_csPicLst")
    blobs = _list_at(data, "picLst")
    # 사진 구분 이름은 사진 행에 없고 구분별 집계 배열에만 있다 — 코드로 조인한다
    category_names = _photo_category_names(data)

    photos = []
    for row, blob in zip(rows, blobs, strict=False):
        parsed = _parse_photo_row(
            row,
            blob,
            court_office_code=court_office_code,
            case_no=case_no,
            category_names=category_names,
        )
        if parsed is not None:
            photos.append(parsed)
    return PhotoPage(
        total_count=_optional_int(page_info.get("totalCnt")) or 0,
        page_no=_optional_int(page_info.get("pageNo")) or 1,
        photos=photos,
    )


def _parse_photo_row(
    row: Any,
    blob: Any,
    *,
    court_office_code: str,
    case_no: str,
    category_names: dict[str, str],
) -> CasePhoto | None:
    if not isinstance(row, dict) or not isinstance(blob, str):
        return None
    try:
        seq = _optional_int(row.get("cortAuctnPicSeq"))
        image = base64.b64decode(blob, validate=True)
    except (CourtPayloadError, binascii.Error, ValueError):
        return None
    if seq is None or not image:
        return None
    category_code = _optional_str(row.get("cortAuctnPicDvsCd"))

    origin = _optional_str(row.get("auctnInfOriginDvsCd"))
    file_dir = _optional_str(row.get("picFileUrl"))
    file_name = _optional_str(row.get("picTitlNm"))
    return CasePhoto(
        court_office_code=court_office_code,
        case_no=case_no,
        seq=seq,
        source=(
            PHOTO_SOURCE_APPRAISAL if origin == _APPRAISAL_ORIGIN_CODE else PHOTO_SOURCE_ITEM
        ),
        category_code=category_code,
        category_name=category_names.get(category_code) if category_code else None,
        # NAS 경로는 직접 접근이 안 된다(실측 404) — 출처 추적용으로만 남긴다
        url=f"{file_dir}{file_name}" if file_dir and file_name else None,
        caption=_optional_str(row.get("picDscrCtt")),
        content_type=_detect_image_type(image),
        image=image,
    )


def _detect_image_type(image: bytes) -> str | None:
    for magic, content_type in _IMAGE_MAGIC_TYPES:
        if image.startswith(magic):
            return content_type
    return None


def _date_from_yyyymmdd(value: Any) -> date | None:
    text = _optional_str(value)
    if text is None or len(text) != 8 or not text.isdigit():
        return None
    try:
        return date(int(text[0:4]), int(text[4:6]), int(text[6:8]))
    except ValueError:
        return None


def _amount_or_none(value: Any) -> int | None:
    """금액 필드 변환 — 법원 응답은 '없음'을 0/빈값으로 주므로 None으로 통일한다."""
    amount = _optional_int(value)
    return amount if amount else None


def _combine_bid_datetime(row: dict[str, Any]) -> str | None:
    """매각기일(maeGiil, YYYYMMDD)과 1회차 매각시각(maeHh1, HHmm)을 합쳐 타임스탬프 문자열을 만든다.

    법원 값은 한국 표준시(KST, UTC+9) 기준이라 +09:00을 명시한다 — 오프셋 없이 저장하면 DB 세션
    시간대(UTC)로 해석돼 실제보다 9시간 늦은 시각으로 조회되는 버그가 있었다.
    """
    date_part = _optional_str(row.get("maeGiil"))
    if date_part is None or len(date_part) != 8:
        return None
    formatted_date = f"{date_part[0:4]}-{date_part[4:6]}-{date_part[6:8]}"

    time_part = _optional_str(row.get("maeHh1"))
    if time_part is not None and len(time_part) == 4:
        return f"{formatted_date} {time_part[0:2]}:{time_part[2:4]}:00+09:00"
    return f"{formatted_date}+09:00"


def _object_at(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise CourtPayloadError(f"{key} must be an object")
    return value


def _list_at(payload: dict[str, Any], key: str) -> list[Any]:
    value = payload.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise CourtPayloadError(f"{key} must be a list")
    return value


def _required_str(payload: dict[str, Any], key: str) -> str:
    value = _optional_str(payload.get(key))
    if value is None:
        raise CourtPayloadError(f"missing required field: {key}")
    return value


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _optional_int(value: Any) -> int | None:
    text = _optional_str(value)
    if text is None:
        return None
    try:
        return int(text.replace(",", ""))
    except ValueError as exc:
        raise CourtPayloadError(f"invalid integer: {text}") from exc


def _optional_float(value: Any) -> float | None:
    text = _optional_str(value)
    if text is None:
        return None
    try:
        return float(text)
    except ValueError as exc:
        raise CourtPayloadError(f"invalid float: {text}") from exc
