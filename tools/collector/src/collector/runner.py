from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import date, timedelta
from typing import Any, Protocol

from collector.court_client import BlockedByCourtError, CourtRequestError
from collector.court_parser import (
    CasePhoto,
    ItemNotice,
    SaleResult,
    SearchPage,
    parse_case_sale_results,
    parse_item_notice,
    parse_photo_page,
    parse_sale_result_page,
)
from collector.notice_document_client import (
    NoticeDocumentRef,
    NoticeDocumentSession,
    notice_document_ref,
)
from collector.notice_pdf_parser import parse_tenant_table_from_cells
from collector.notice_pdf_reader import PdfReadError, pdf_to_document
from collector.notice_tenant_parser import NoticeTenant, TenantTable, parse_tenant_table
from collector.repository import UpsertResult


logger = logging.getLogger(__name__)

# 점유자 표는 명세서 1쪽에 있고, 점유자가 많으면 다음 쪽으로 이어진다 — 이어질 때만 더 받는다
NOTICE_TEXT_MAX_PAGES = 2

# 명세서가 연속으로 이만큼 비면 법원 스로틀로 보고 그 법원을 중단한다 (WP-11 §4-10).
# 실측(2026-08-04): 180건 정상 뒤 **287건이 연속으로** 빈 응답이었고 3시간 뒤 정상 복구됐다.
# 개별 물건 사정(기일 지남·미작성)이라면 이만큼 길게 연속될 수 없다. 20은 그 사이를 가르는
# 보수적인 값이다 — 진짜 미작성 구간을 잘못 끊더라도 다음 실행이 재시도하므로 손실이 없다.
UNAVAILABLE_STREAK_LIMIT = 20

# 명세서 진행 로그 간격(물건 수). 물건당 5요청·1.5초 간격이라 25건이면 약 3분마다 한 줄이다 —
# 살아 있는지 확인하기엔 충분하고 로그를 덮을 만큼 잦지도 않다.
NOTICE_PROGRESS_EVERY = 25

# 물건상세검색 화면(PGJ151F01) 기본값 — 부동산·기일입찰·법원별검색, 오늘부터 2주 후 매각기일까지
SEARCH_PERIOD_DAYS = 14
PAGE_SIZE = 10

# 매각결과검색은 pageSize 100을 HTTP 400으로 거부한다 — 10~20만 허용
SALE_RESULT_PAGE_SIZE = 20

# 사진조회는 pageSize 30까지 실측으로 확인했다 — 27장 사건도 1요청에 담긴다
PHOTO_PAGE_SIZE = 30
# 사진이 이보다 많은 사건은 비정상으로 보고 남은 쪽은 받지 않는다 (요청 폭주 방지)
PHOTO_MAX_PAGES = 5

# 내부 사건번호(csNo)의 사건부호 코드 — "타경"(경매사건)은 0130이다.
# 실측: 2025타경52037 → 20250130052037, 2024타경119676 → 20240130119676
_CASE_NO_PATTERN = re.compile(r"^(\d{4})타경(\d{1,6})$")


class SearchClient(Protocol):
    def search_items(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class AuctionRepository(Protocol):
    def upsert_items(self, items: list[Any]) -> UpsertResult: ...


class SaleResultSearchClient(Protocol):
    def search_sale_results(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class CaseSearchClient(Protocol):
    def search_case(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class SaleResultRepository(Protocol):
    def upsert_sale_results(self, results: list[SaleResult]) -> UpsertResult: ...


class BackfillRepository(Protocol):
    def find_items_pending_sale_result(self) -> list[dict[str, Any]]: ...

    def upsert_sale_results(self, results: list[SaleResult]) -> UpsertResult: ...


class ItemDetailClient(Protocol):
    def search_items(self, payload: dict[str, Any]) -> dict[str, Any]: ...

    def search_item_detail(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class NoticeRepository(Protocol):
    def upsert_notices(self, notices: list[ItemNotice]) -> UpsertResult: ...


class NoticeDocumentReader(Protocol):
    def open_document(self, ref: NoticeDocumentRef) -> NoticeDocumentSession | None: ...

    def fetch_text_page(self, session: NoticeDocumentSession, page: int) -> list[Any]: ...

    def fetch_pdf(self, session: NoticeDocumentSession) -> bytes: ...


class PhotoSearchClient(Protocol):
    def search_photos(self, payload: dict[str, Any]) -> dict[str, Any]: ...


class PhotoRepository(Protocol):
    def find_cases_missing_photos(
        self, court_office_code: str | None = None
    ) -> list[dict[str, Any]]: ...

    def upsert_case_photos(
        self, court_office_code: str, case_no: str, photos: list[CasePhoto]
    ) -> UpsertResult: ...


ParseSearchPage = Callable[[dict[str, Any]], SearchPage]


class DailyClient(ItemDetailClient, CaseSearchClient, PhotoSearchClient, Protocol):
    """daily가 쓰는 법원 요청 모음 — 검색·물건상세·사건검색·사진조회."""


class DailyRepository(
    AuctionRepository, NoticeRepository, BackfillRepository, PhotoRepository, Protocol
):
    """daily가 쓰는 저장소 모음 — 물건·명세서·매각결과·사진."""

    def find_item_keys_with_notice(self) -> set[tuple[str, str, str, date | None]]: ...

    def find_item_keys_with_tenant_scan(self) -> set[tuple[str, str, str, date | None]]: ...

    def find_item_keys_needing_pdf_rescan(self) -> set[tuple[str, str, str, date | None]]: ...

    def mask_ended_case_tenant_names(self) -> int: ...

    def count_unmasked_tenant_names(self) -> int: ...


@dataclass(frozen=True)
class CollectionTarget:
    court_office_code: str
    page_no: int = 1


def run_collection(
    *,
    run_id: str,
    target: CollectionTarget,
    client: SearchClient,
    repository: AuctionRepository,
    parse_search_page: ParseSearchPage,
) -> UpsertResult:
    _, result = _collect_search_page(
        run_id=run_id,
        target=target,
        client=client,
        repository=repository,
        parse_search_page=parse_search_page,
    )
    return result


def _collect_search_page(
    *,
    run_id: str,
    target: CollectionTarget,
    client: SearchClient,
    repository: AuctionRepository,
    parse_search_page: ParseSearchPage,
) -> tuple[SearchPage, UpsertResult]:
    """검색 한 페이지를 수집·저장한다 — 기본 수집과 daily 1단계가 공유한다."""
    page = parse_search_page(client.search_items(build_search_payload(target)))
    result = repository.upsert_items(page.items)

    logger.info(
        "collector_page run_id=%s court=%s page=%s processed=%s inserted=%s updated=%s skipped=%s",
        run_id,
        target.court_office_code,
        target.page_no,
        len(page.items),
        result.inserted,
        result.updated,
        result.skipped,
    )

    return page, result


def build_search_payload(target: CollectionTarget, *, today: date | None = None) -> dict[str, Any]:
    """WebSquare submission `sbm_selectGdsDtlSrch`가 기대하는 실제 페이로드를 만든다.

    필드 목록·상수값은 브라우저에서 물건상세검색(부동산/기일입찰/법원별검색) 기본값으로
    검색 버튼을 눌러 캡처한 실제 요청을 기준으로 한다 (`tests/fixtures/court_search_request.json`).
    """
    bid_begin = today or date.today()
    bid_end = bid_begin + timedelta(days=SEARCH_PERIOD_DAYS)

    return {
        "dma_pageInfo": {
            "pageNo": target.page_no,
            "pageSize": PAGE_SIZE,
            "bfPageNo": "",
            "startRowNo": "",
            "totalCnt": "",
            "totalYn": "Y" if target.page_no == 1 else "N",
            "groupTotalCount": "",
        },
        "dma_srchGdsDtlSrchInfo": {
            "rletDspslSpcCondCd": "",
            "bidDvsCd": "000331",
            "mvprpRletDvsCd": "00031R",
            "cortAuctnSrchCondCd": "0004601",
            "rprsAdongSdCd": "",
            "rprsAdongSggCd": "",
            "rprsAdongEmdCd": "",
            "rdnmSdCd": "",
            "rdnmSggCd": "",
            "rdnmNo": "",
            "mvprpDspslPlcAdongSdCd": "",
            "mvprpDspslPlcAdongSggCd": "",
            "mvprpDspslPlcAdongEmdCd": "",
            "rdDspslPlcAdongSdCd": "",
            "rdDspslPlcAdongSggCd": "",
            "rdDspslPlcAdongEmdCd": "",
            "cortOfcCd": target.court_office_code,
            "jdbnCd": "",
            "execrOfcDvsCd": "",
            "lclDspslGdsLstUsgCd": "",
            "mclDspslGdsLstUsgCd": "",
            "sclDspslGdsLstUsgCd": "",
            "cortAuctnMbrsId": "",
            "aeeEvlAmtMin": "",
            "aeeEvlAmtMax": "",
            "lwsDspslPrcRateMin": "",
            "lwsDspslPrcRateMax": "",
            "flbdNcntMin": "",
            "flbdNcntMax": "",
            "objctArDtsMin": "",
            "objctArDtsMax": "",
            "mvprpArtclKndCd": "",
            "mvprpArtclNm": "",
            "mvprpAtchmPlcTypCd": "",
            "notifyLoc": "off",
            "lafjOrderBy": "",
            "pgmId": "PGJ151F01",
            "csNo": "",
            "cortStDvs": "1",
            "statNum": 1,
            "bidBgngYmd": bid_begin.strftime("%Y%m%d"),
            "bidEndYmd": bid_end.strftime("%Y%m%d"),
            "dspslDxdyYmd": "",
            "fstDspslHm": "",
            "scndDspslHm": "",
            "thrdDspslHm": "",
            "fothDspslHm": "",
            "dspslPlcNm": "",
            "lwsDspslPrcMin": "",
            "lwsDspslPrcMax": "",
            "grbxTypCd": "",
            "gdsVendNm": "",
            "fuelKndCd": "",
            "carMdyrMax": "",
            "carMdyrMin": "",
            "carMdlNm": "",
            "sideDvsCd": "",
        },
    }


def build_sale_result_payload(
    court_office_code: str,
    *,
    page_no: int = 1,
    status_code: str = "",
) -> dict[str, Any]:
    """매각결과검색 submission(sbm_selectDspslSchdRsltSrch)이 기대하는 페이로드를 만든다.

    물건상세검색 페이로드에서 파생 — 화면 PGJ158M01 기준으로 statNum "3"이며,
    날짜 조건이 없고(최근 7일 스냅샷 고정) auctnGdsStatCd ""=전체 | "02"=매각 | "03"=유찰.
    """
    payload = build_search_payload(
        CollectionTarget(court_office_code=court_office_code, page_no=page_no)
    )
    payload["dma_pageInfo"]["pageSize"] = SALE_RESULT_PAGE_SIZE
    search_info = payload["dma_srchGdsDtlSrchInfo"]
    search_info["statNum"] = "3"
    search_info["pgmId"] = "PGJ158M01"
    search_info["auctnGdsStatCd"] = status_code
    search_info["bidBgngYmd"] = ""
    search_info["bidEndYmd"] = ""
    return payload


def notice_bid_date(row: dict[str, Any]) -> date | None:
    """검색 행의 매각기일(maeGiil, YYYYMMDD)을 날짜로 바꾼다.

    명세서가 어느 기일 것인지 표시하는 데 쓴다. 값이 없으면 None이고, 그때는 daily가 기일 비교를
    포기하고 예전처럼 "명세서 유무"로만 판단한다 — 매일 다시 받는 것보다 낫다.
    """
    raw = str(row.get("maeGiil") or "")
    if len(raw) != 8 or not raw.isdigit():
        return None
    try:
        return date(int(raw[0:4]), int(raw[4:6]), int(raw[6:8]))
    except ValueError:
        return None


def build_case_search_payload(court_office_code: str, case_no: str) -> dict[str, Any]:
    """경매사건검색(sbm_selectAuctnCsSrchRslt) 페이로드 — 사람이 읽는 사건번호 그대로 보낸다."""
    return {"dma_srchCsDtlInf": {"cortOfcCd": court_office_code, "csNo": case_no}}


def build_item_detail_payload(
    target: CollectionTarget,
    *,
    case_no: str,
    goods_seq: str,
    row_index: int = 0,
) -> dict[str, Any]:
    """물건상세(sbm_selectGdsDtlSrchDtlInfo) 페이로드를 만든다.

    `goods_seq`는 물건번호(검색 결과의 maemulSer)다. 목적물번호(mokmulSer=우리 item_no)와
    다른 사건이 있으므로 섞어 쓰면 다른 물건의 명세서를 받는다 (WP-11 §4-2).
    """
    search_info = build_search_payload(target)["dma_srchGdsDtlSrchInfo"]
    search_info["sideDvsCd"] = "2"
    search_info["srchRowIndex"] = row_index
    search_info["menuNm"] = "물건상세검색"

    return {
        "dma_srchGdsDtlSrch": {
            "csNo": case_no,
            "cortOfcCd": target.court_office_code,
            "dspslGdsSeq": goods_seq,
            "pgmId": "PGJ151F01",
            "srchInfo": search_info,
        }
    }


def run_notice_collection(
    *,
    run_id: str,
    target: CollectionTarget,
    client: ItemDetailClient,
    repository: NoticeRepository,
    limit: int | None = None,
    document_reader: NoticeDocumentReader | None = None,
) -> UpsertResult:
    """지금 공고 중인 물건의 매각물건명세서 기재사항을 수집한다.

    검색 결과 한 페이지의 물건을 하나씩 상세조회한다 — 상세조회가 물건당 1회 요청이므로
    limit으로 한 번에 도는 물건 수를 제한한다. 물건 하나가 실패해도 다음 물건을 계속
    처리하되, 차단 신호는 즉시 전파한다.

    `document_reader`를 주면 명세서 PDF까지 열어 점유자(임차인) 표를 함께 채운다.
    물건당 요청이 3회 이상 늘어나므로 필요한 실행에서만 넘긴다.
    """
    rows = _search_result_rows(client.search_items(build_search_payload(target)))
    if limit is not None:
        rows = rows[:limit]

    batch = _collect_notices_for_rows(
        run_id=run_id,
        target=target,
        client=client,
        indexed_rows=list(enumerate(rows)),
        document_reader=document_reader,
    )
    result = repository.upsert_notices(batch.notices)

    logger.info(
        "notice_collection run_id=%s court=%s items=%s parsed=%s tenants=%s "
        "tenants_rejected=%s inserted=%s updated=%s skipped=%s store_failed=%s failed=%s",
        run_id,
        target.court_office_code,
        len(rows),
        len(batch.notices),
        batch.tenant_rows,
        batch.tenant_rejected,
        result.inserted,
        result.updated,
        result.skipped,
        result.failed,
        batch.failed,
    )

    return result


@dataclass(frozen=True)
class _NoticeBatch:
    """검색 결과 행들을 상세조회한 결과 묶음 — unavailable은 명세서가 응답에 없던 물건 수."""

    notices: list[ItemNotice]
    failed: int
    unavailable: int
    tenant_rows: int
    tenant_rejected: int


def _collect_notices_for_rows(
    *,
    run_id: str,
    target: CollectionTarget,
    client: ItemDetailClient,
    indexed_rows: list[tuple[int, dict[str, Any]]],
    document_reader: NoticeDocumentReader | None,
) -> _NoticeBatch:
    """검색 결과 행을 물건당 1회 상세조회해 명세서를 모은다 — notices와 daily 2단계가 공유한다."""
    notices: list[ItemNotice] = []
    failed_items = 0
    unavailable_items = 0
    tenant_rows = 0
    tenant_rejected = 0
    consecutive_unavailable = 0
    processed = 0

    for row_index, row in indexed_rows:
        processed += 1
        # 진행 로그. 명세서 단계는 성공한 물건을 로그하지 않아서, 정상 동작 중일수록 조용하다.
        # 물건당 5요청 이상이라 수백 건이면 수십 분이 걸리는데 그동안 살아 있는지 알 방법이 없었다
        # (2026-08-04에 이것 때문에 "죽었나"를 세 번 오판했다). 역설적으로 로그가 쏟아지면
        # 스로틀에 걸렸다는 뜻이었다 — 실패만 찍혔기 때문이다.
        if processed % NOTICE_PROGRESS_EVERY == 0:
            logger.info(
                "notice_progress run_id=%s court=%s %s/%s parsed=%s unavailable=%s tenants=%s",
                run_id,
                target.court_office_code,
                processed,
                len(indexed_rows),
                len(notices),
                unavailable_items,
                tenant_rows,
            )
        case_no = str(row.get("srnSaNo") or "")
        goods_seq = str(row.get("maemulSer") or "")
        item_no = str(row.get("mokmulSer") or "")
        if not (case_no and goods_seq and item_no):
            failed_items += 1
            continue

        payload = build_item_detail_payload(
            target, case_no=case_no, goods_seq=goods_seq, row_index=row_index
        )
        try:
            response = client.search_item_detail(payload)
        except CourtRequestError as exc:
            failed_items += 1
            logger.warning(
                "notice_item_failed run_id=%s court=%s case=%s item=%s error=%s",
                run_id,
                target.court_office_code,
                case_no,
                item_no,
                exc,
            )
            continue

        notice = parse_item_notice(
            response,
            court_office_code=target.court_office_code,
            case_no=case_no,
            item_no=item_no,
        )
        if notice is None:
            # 응답에 명세서가 없다 — 기일이 지났거나(영구 소실), 아직 작성 전이거나,
            # 법원이 스로틀로 빈 응답을 주기 시작한 것이다 (WP-11 §4-10). 셋을 구분할 수 없다.
            unavailable_items += 1
            consecutive_unavailable += 1
            logger.info(
                "notice_item_unavailable run_id=%s court=%s case=%s item=%s",
                run_id,
                target.court_office_code,
                case_no,
                item_no,
            )
            # 연속으로 이만큼 비면 스로틀로 본다. 실측(2026-08-04): 180건 정상 뒤 287건이 **연속으로**
            # 비었고 3시간 뒤 정상 복구됐다. 개별 물건 사정이라면 이렇게 길게 연속될 수 없다.
            # 계속 돌아봐야 빈 응답만 받으므로 멈추고 다음 실행에 맡긴다 — 명세서 행이 안 생기니
            # 다음 실행이 자동으로 재시도한다.
            if consecutive_unavailable >= UNAVAILABLE_STREAK_LIMIT:
                logger.warning(
                    "notice_throttle_suspected run_id=%s court=%s streak=%s remaining=%s",
                    run_id,
                    target.court_office_code,
                    consecutive_unavailable,
                    len(indexed_rows) - processed,
                )
                break
            continue

        consecutive_unavailable = 0

        # 이 명세서가 어느 기일 것인지는 검색 행에만 있다 — 명세서 본문에는 기일이 없다
        notice = replace(notice, bid_date=notice_bid_date(row))

        if document_reader is not None:
            scan = _collect_notice_tenants(
                run_id=run_id, reader=document_reader, detail_payload=response, case_no=case_no
            )
            notice = replace(
                notice,
                tenants=scan.tenants,
                tenants_scanned=scan.scanned,
                tenants_rejected=scan.rejected if scan.scanned else None,
                tenants_continued=scan.continued if scan.scanned else None,
                tenant_text_region=scan.region_lines if scan.scanned else None,
                tenant_source=scan.source,
                pdf_bytes=scan.pdf,
            )
            tenant_rows += len(scan.tenants)
            tenant_rejected += scan.rejected
        notices.append(notice)

    return _NoticeBatch(
        notices=notices,
        failed=failed_items,
        unavailable=unavailable_items,
        tenant_rows=tenant_rows,
        tenant_rejected=tenant_rejected,
    )


@dataclass(frozen=True)
class _TenantScan:
    """점유자 표 스캔 결과. 값이 여섯이라 튜플로는 호출부에서 읽히지 않는다.

    `source`는 어느 경로로 읽었는지다(018). PDF 괘선과 텍스트 레이어는 정확도가 달라
    섞어서 통계를 내면 안 된다.
    """

    tenants: tuple[NoticeTenant, ...] = ()
    rejected: int = 0
    scanned: bool = False
    continued: bool | None = None
    region_lines: tuple[tuple[Any, ...], ...] = ()
    source: str | None = None
    # 받은 PDF 원본. 화면에서 원문 확인용으로 보관한다(019) — 열람 창이 닫히면 다시 못 받는다
    pdf: bytes | None = None


def _collect_notice_tenants(
    *,
    run_id: str,
    reader: NoticeDocumentReader,
    detail_payload: dict[str, Any],
    case_no: str,
) -> _TenantScan:
    """명세서 PDF에서 점유자 표를 읽어 (저장할 행, 버린 행 수, 문서를 열었는지, 표가 이어지는지,
    표 영역 원문)를 돌려준다.

    열람 창(매각기일 1주 전~기일) 밖이면 문서를 열 수 없어 빈 값을 돌려준다 — 기재사항 수집은
    그대로 진행한다. 표가 다음 쪽으로 이어질 때만 쪽을 더 받는다.

    세 번째 값은 문서를 열어 파싱까지 끝냈는지다. 표가 비어 있어도(임차인 없는 물건) True라서
    daily가 "다시 열 필요 없음"을 판단할 수 있다.

    다섯 번째 값은 표 영역의 텍스트 레이어 원문이다 — 파서를 고친 뒤 재수집 없이 다시 파싱하려고
    남긴다 (017). 문서를 못 열었으면 빈 값이다.

    네 번째 값은 마지막으로 읽은 쪽에서 표가 아직 이어지고 있었는지다. 쪽 상한
    (NOTICE_TEXT_MAX_PAGES)까지 읽고도 True면 표가 잘렸다는 뜻이라 "행이 없다"를 근거로 쓸 수
    없다. 문서를 못 열었으면 None(모름)이다 (WP-11 §4-26).
    """
    ref = notice_document_ref(detail_payload)
    if ref is None:
        return _TenantScan()

    session = reader.open_document(ref)
    if session is None:
        logger.info("notice_document_unavailable run_id=%s case=%s", run_id, case_no)
        return _TenantScan()

    # 괘선이 있는 PDF를 먼저 시도한다. 텍스트 레이어에는 표 경계가 없어 임차인의 행·사람을
    # 못 가른다(WP-11 §4-30) — 실측 2025타경103032: 임차인 둘이 한 명으로 뭉치며 보증금
    # 2억6,955만이 통째로 사라졌다. 차단(BlockedByCourtError)은 잡지 않고 올린다 (D-007).
    try:
        pdf = reader.fetch_pdf(session)
        table = parse_tenant_table_from_cells(pdf_to_document(pdf))
    except (PdfReadError, CourtRequestError) as exc:
        logger.warning(
            "notice_pdf_failed run_id=%s case=%s error=%s — 텍스트 레이어로 폴백", run_id, case_no, exc
        )
    else:
        _warn_if_all_rejected(run_id, case_no, table)
        return _TenantScan(
            tenants=table.tenants,
            rejected=table.rejected,
            scanned=True,
            continued=table.continued,
            region_lines=table.region_lines,
            source="PDF_CELLS",
            pdf=pdf,
        )

    pages: list[list[Any]] = []
    for page in range(NOTICE_TEXT_MAX_PAGES):
        pages.append(reader.fetch_text_page(session, page))
        table = parse_tenant_table(pages)
        if not table.continued:
            break
    _warn_if_all_rejected(run_id, case_no, table)
    return _TenantScan(
        tenants=table.tenants,
        rejected=table.rejected,
        scanned=True,
        continued=table.continued,
        region_lines=table.region_lines,
        source="TEXT_LAYER",
    )


def _warn_if_all_rejected(run_id: str, case_no: str, table: TenantTable) -> None:
    """행이 있었는데 전부 검증 게이트에서 버려졌다 — 새 변형 레이아웃일 가능성이 크다.

    이 로그가 없으면 "임차인 없음"과 구분되지 않아 소실을 알아챌 수 없다 (실측 2026-08-06:
    좌측 밀림 레이아웃 문서들이 이 경로로 조용히 사라졌다).
    """
    if not table.tenants and table.rejected:
        logger.warning(
            "notice_tenants_all_rejected run_id=%s case=%s rejected=%s",
            run_id,
            case_no,
            table.rejected,
        )


def _search_result_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data")
    rows = data.get("dlt_srchResult") if isinstance(data, dict) else None
    return [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []


def internal_case_no(case_no: str) -> str | None:
    """사람이 읽는 사건번호를 내부 표기(csNo)로 바꾼다 — 2025타경52037 → 20250130052037.

    사진조회는 내부 사건번호만 받는다. 타경(0130) 외 사건부호는 다루지 않으므로 None을 준다.
    """
    match = _CASE_NO_PATTERN.match(case_no)
    if match is None:
        return None
    year, serial = match.groups()
    return f"{year}0130{serial.zfill(6)}"


def build_photo_payload(
    court_office_code: str,
    internal_cs_no: str,
    *,
    page_no: int = 1,
    page_size: int = PHOTO_PAGE_SIZE,
) -> dict[str, Any]:
    """사진조회 submission(sbm_selectPicInfoLst)이 기대하는 페이로드를 만든다.

    필드 목록·상수값은 사진보기 팝업(PGJ15BP06)에서 캡처한 실제 요청 그대로다.
    사진은 사건 단위라 물건번호(goods_seq)를 받지 않는다.
    """
    return {
        "dma_pageInfo": {
            "pageNo": page_no,
            "pageSize": page_size,
            "bfPageNo": "",
            "startRowNo": "",
            "totalCnt": "",
            "totalYn": "Y" if page_no == 1 else "N",
        },
        "dma_srchPicInf": {
            "cortOfcCd": court_office_code,
            "csNo": internal_cs_no,
            "ordTsCnt": "",
            "auctnInfOriginDvsCd": "",
            "pgmId": "PGJ15BP06",
            "cortAuctnPicDvsCd": "",
            "flag": "",
        },
    }


def run_photo_collection(
    *,
    run_id: str,
    client: PhotoSearchClient,
    repository: PhotoRepository,
    court_office_code: str | None = None,
    limit: int | None = None,
) -> UpsertResult:
    """사진이 아직 없는 사건의 물건 사진을 수집한다.

    사진은 사건 단위로 제공되므로 사건당 1회(30장 초과 시 페이지 추가) 요청한다.
    실측상 매각기일이 지난 사건도 조회된다(창 제한 없음). 사건 하나가 실패해도 다음
    사건을 계속 처리하되, 차단 신호는 즉시 전파한다.
    """
    pending = repository.find_cases_missing_photos(court_office_code)
    if limit is not None:
        pending = pending[:limit]

    total_inserted = 0
    total_updated = 0
    total_skipped = 0
    failed_cases = 0

    for row in pending:
        court = str(row["court_office_code"])
        case_no = str(row["case_no"])
        cs_no = internal_case_no(case_no)
        if cs_no is None:
            failed_cases += 1
            logger.warning(
                "photo_case_skipped run_id=%s court=%s case=%s reason=사건부호_비지원",
                run_id,
                court,
                case_no,
            )
            continue

        try:
            photos = _fetch_case_photos(client, court=court, case_no=case_no, cs_no=cs_no)
        except CourtRequestError as exc:
            failed_cases += 1
            logger.warning(
                "photo_case_failed run_id=%s court=%s case=%s error=%s",
                run_id,
                court,
                case_no,
                exc,
            )
            continue

        result = repository.upsert_case_photos(court, case_no, photos)
        total_inserted += result.inserted
        total_updated += result.updated
        total_skipped += result.skipped

        total_bytes = sum(len(photo.image) for photo in photos)
        logger.info(
            "photo_case run_id=%s court=%s case=%s photos=%s bytes=%s "
            "inserted=%s updated=%s skipped=%s",
            run_id,
            court,
            case_no,
            len(photos),
            total_bytes,
            result.inserted,
            result.updated,
            result.skipped,
        )

    logger.info(
        "photo_collection run_id=%s court=%s cases=%s inserted=%s updated=%s "
        "skipped=%s failed=%s",
        run_id,
        court_office_code or "전체",
        len(pending),
        total_inserted,
        total_updated,
        total_skipped,
        failed_cases,
    )

    return UpsertResult(inserted=total_inserted, updated=total_updated, skipped=total_skipped)


def _fetch_case_photos(
    client: PhotoSearchClient, *, court: str, case_no: str, cs_no: str
) -> list[CasePhoto]:
    """한 사건의 사진을 전부 받는다 — 총 건수가 한 페이지를 넘으면 다음 페이지를 이어 받는다."""
    photos: list[CasePhoto] = []
    for page_no in range(1, PHOTO_MAX_PAGES + 1):
        payload = build_photo_payload(court, cs_no, page_no=page_no)
        page = parse_photo_page(
            client.search_photos(payload), court_office_code=court, case_no=case_no
        )
        photos.extend(page.photos)
        if len(photos) >= page.total_count or not page.photos:
            break
    return photos


def run_sale_result_sweep(
    *,
    run_id: str,
    court_office_code: str,
    client: SaleResultSearchClient,
    repository: SaleResultRepository,
    status_code: str = "",
    max_pages: int = 50,
) -> UpsertResult:
    """매각결과검색으로 최근 7일 매각/유찰 결과를 페이지 순회하며 수집한다."""
    total_inserted = 0
    total_skipped = 0

    for page_no in range(1, max_pages + 1):
        payload = build_sale_result_payload(
            court_office_code, page_no=page_no, status_code=status_code
        )
        page = parse_sale_result_page(client.search_sale_results(payload))
        result = repository.upsert_sale_results(page.results)
        total_inserted += result.inserted
        total_skipped += result.skipped

        logger.info(
            "sale_result_sweep run_id=%s court=%s page=%s total=%s rows=%s inserted=%s skipped=%s",
            run_id,
            court_office_code,
            page_no,
            page.total_count,
            len(page.results),
            result.inserted,
            result.skipped,
        )

        if page_no * SALE_RESULT_PAGE_SIZE >= page.total_count:
            break

    return UpsertResult(inserted=total_inserted, updated=0, skipped=total_skipped)


def run_sale_result_backfill(
    *,
    run_id: str,
    client: CaseSearchClient,
    repository: BackfillRepository,
    limit: int | None = None,
) -> UpsertResult:
    """매각기일이 지났는데 결과가 없는 물건을 사건검색으로 조회해 결과를 채운다.

    한 사건에 물건이 여러 개일 수 있으므로 사건 단위로 중복 제거해 요청한다.
    사건 하나가 실패해도(종국 등) 다음 사건을 계속 처리하되, 차단 신호는 즉시 전파한다.
    """
    pending = repository.find_items_pending_sale_result()
    cases: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for row in pending:
        key = (row["court_office_code"], row["case_no"])
        if key not in seen:
            seen.add(key)
            cases.append(key)
    if limit is not None:
        cases = cases[:limit]

    total_inserted = 0
    total_skipped = 0
    failed_cases = 0

    for court_office_code, case_no in cases:
        try:
            response = client.search_case(build_case_search_payload(court_office_code, case_no))
        except CourtRequestError as exc:
            failed_cases += 1
            logger.warning(
                "sale_result_backfill_case_failed run_id=%s court=%s case=%s error=%s",
                run_id,
                court_office_code,
                case_no,
                exc,
            )
            continue

        results = parse_case_sale_results(
            response, court_office_code=court_office_code, case_no=case_no
        )
        result = repository.upsert_sale_results(results)
        total_inserted += result.inserted
        total_skipped += result.skipped

        logger.info(
            "sale_result_backfill_case run_id=%s court=%s case=%s rows=%s inserted=%s skipped=%s",
            run_id,
            court_office_code,
            case_no,
            len(results),
            result.inserted,
            result.skipped,
        )

    logger.info(
        "sale_result_backfill_done run_id=%s pending=%s cases=%s inserted=%s skipped=%s failed=%s",
        run_id,
        len(pending),
        len(cases),
        total_inserted,
        total_skipped,
        failed_cases,
    )

    return UpsertResult(inserted=total_inserted, updated=0, skipped=total_skipped)


@dataclass(frozen=True)
class DailySummary:
    """daily 한 번의 결과 요약 — notice_unavailable이 0이 아니면 영구 손실이 발생한 것이다."""

    requests_total: int
    notice_unavailable: int
    stage_failures: int


class _CountingClient:
    """법원 요청 수를 세는 래퍼 — daily 로그의 단계별 사용량이 여기서 나온다."""

    def __init__(self, client: DailyClient) -> None:
        self._client = client
        self.requests = 0

    def search_items(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.requests += 1
        return self._client.search_items(payload)

    def search_item_detail(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.requests += 1
        return self._client.search_item_detail(payload)

    def search_case(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.requests += 1
        return self._client.search_case(payload)

    def search_photos(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.requests += 1
        return self._client.search_photos(payload)


class _CountingDocumentReader:
    """명세서 문서 요청 수를 세는 래퍼 — 문서 열기 3회 + 쪽당 1회 + PDF 2회.

    PDF는 사본 생성(/changes)과 다운로드 두 번이다 (WP-11 §4-31).
    """

    def __init__(self, reader: NoticeDocumentReader, counter: _CountingClient) -> None:
        self._reader = reader
        self._counter = counter

    def open_document(self, ref: NoticeDocumentRef) -> NoticeDocumentSession | None:
        self._counter.requests += 3
        return self._reader.open_document(ref)

    def fetch_text_page(self, session: NoticeDocumentSession, page: int) -> list[Any]:
        self._counter.requests += 1
        return self._reader.fetch_text_page(session, page)

    def fetch_pdf(self, session: NoticeDocumentSession) -> bytes:
        self._counter.requests += 2
        return self._reader.fetch_pdf(session)


def run_daily(
    *,
    run_id: str,
    court_office_codes: list[str],
    client: DailyClient,
    repository: DailyRepository,
    parse_search_page: ParseSearchPage,
    document_reader: NoticeDocumentReader | None = None,
    max_search_pages: int = 50,
    notice_limit: int | None = None,
    rescan_limit: int = 40,
    backfill_limit: int | None = None,
    photo_limit: int | None = None,
) -> DailySummary:
    """하루 1회 전체 수집 — 물건(전 페이지) → 명세서(없는 물건만) → 매각결과 → 사진 순서.

    순서가 설계다: 명세서는 매각기일이 지나면 영영 못 받으므로(WP-11 §4-3) 물건 수집 직후
    가장 먼저 채운다. 한 단계가 실패해도 다음 단계는 계속하되, 차단 신호(403/429,
    BlockedByCourtError)는 우회하지 않고 즉시 전체를 중단한다 (D-007).
    """
    counting = _CountingClient(client)
    counting_reader = (
        _CountingDocumentReader(document_reader, counting) if document_reader is not None else None
    )
    stage_failures = 0

    # 1단계 — 물건 수집: 법원별로 totalCnt 기준 마지막 페이지까지 순회. 새 물건이 여기서 들어온다.
    # 검색 행(maemulSer 포함)을 페이지 내 순번과 함께 모아 2단계 명세서 수집에 재사용한다
    # — 같은 검색을 두 번 돌리지 않기 위해서다.
    indexed_rows_by_court: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    items_processed = items_inserted = items_updated = items_skipped = 0
    pages_fetched = 0
    failed_courts = 0
    for court in court_office_codes:
        rows = indexed_rows_by_court.setdefault(court, [])
        page_no = 1
        total_count = 0
        try:
            while True:
                page, result = _collect_search_page(
                    run_id=run_id,
                    target=CollectionTarget(court_office_code=court, page_no=page_no),
                    client=counting,
                    repository=repository,
                    parse_search_page=parse_search_page,
                )
                pages_fetched += 1
                items_processed += len(page.items)
                items_inserted += result.inserted
                items_updated += result.updated
                items_skipped += result.skipped
                rows.extend((index, item.raw) for index, item in enumerate(page.items))
                if page_no == 1:
                    total_count = page.total_count  # totalCnt는 1페이지(totalYn=Y) 응답에만 온다
                if not page.items or page_no * PAGE_SIZE >= total_count:
                    break
                if page_no >= max_search_pages:
                    break
                page_no += 1
        except BlockedByCourtError:
            raise
        except Exception as exc:  # 한 법원 실패가 다른 법원·다음 단계를 막으면 안 된다
            failed_courts += 1
            stage_failures += 1
            logger.warning(
                "daily_items_court_failed run_id=%s court=%s page=%s error=%s",
                run_id,
                court,
                page_no,
                exc,
            )
    logger.info(
        "daily_items run_id=%s courts=%s pages=%s processed=%s inserted=%s updated=%s "
        "skipped=%s failed_courts=%s requests=%s",
        run_id,
        len(court_office_codes),
        pages_fetched,
        items_processed,
        items_inserted,
        items_updated,
        items_skipped,
        failed_courts,
        counting.requests,
    )

    # 2단계 — 명세서 수집: 가장 급하다. 이미 명세서가 있는 물건은 상세조회를 건너뛴다.
    # 단순화: 명세서는 기일마다 새로 작성될 수 있지만(document_date가 다름) 물건에 한 건이라도
    # 있으면 스킵한다 — 매일 전부 다시 받는 비용(물건당 1요청)이 그 가치를 넘는다.
    #
    # 단 점유자 표를 받는 실행(--with-tenants)에서는 기재사항만 있는 물건도 다시 열어야 한다.
    # 표는 PDF에만 있고 열람 창(기일 1주 전~기일) 안에서만 얻을 수 있어, 기재사항이 먼저 들어온
    # 물건은 명세서 보유로 스킵되면 표를 영영 못 받는다 (기일이 지나면 영구 소실 — WP-11 §4-3).
    requests_start = counting.requests
    candidates = skipped_existing = detailed = rescanned = 0
    notices_parsed = notice_unavailable = notice_failed = 0
    tenants_total = tenants_rejected = 0
    notices_inserted = notices_updated = notices_skipped = notices_store_failed = 0
    try:
        have_notice = repository.find_item_keys_with_notice()  # 자연키 집합, DB 조회 1회
        # 표를 받는 실행에서만 필요하다 — 안 받는 실행에서 조회하면 쓰지도 않을 쿼리를 매일 돈다
        have_tenant_scan = (
            repository.find_item_keys_with_tenant_scan() if document_reader is not None else set()
        )
        # PDF 괘선으로 다시 받을 것 (018). 저장소가 경과시간까지 걸러서 낸다 — 계속 실패하는
        # 문서가 매 회차 재시도돼 재수집 예산을 독점하지 않게
        need_rescan = (
            repository.find_item_keys_needing_pdf_rescan()
            if document_reader is not None
            else set()
        )
    except Exception as exc:
        have_notice = None
        stage_failures += 1
        logger.warning("daily_notices_failed run_id=%s error=%s", run_id, exc)
    if have_notice is not None:
        for court in court_office_codes:
            missing: list[tuple[int, dict[str, Any]]] = []
            rescans: list[tuple[int, dict[str, Any]]] = []
            seen: set[tuple[str, str, str]] = set()
            for row_index, row in indexed_rows_by_court.get(court, []):
                key = (court, str(row.get("srnSaNo") or ""), str(row.get("mokmulSer") or ""))
                if key in seen:
                    continue
                seen.add(key)
                candidates += 1
                # 이번 기일의 명세서를 갖고 있는지로 판단한다 — 물건 단위로 보면 유찰 후 새 기일의
                # 명세서를 영영 못 받는다 (§4-13). 기일을 모르는 행은 예전처럼 유무로만 판단한다
                bid_key = (*key, notice_bid_date(row))
                # 아직 표를 못 받은 것과, 텍스트 레이어로 받아 다시 받을 것을 나눈다.
                # 신규는 창이 닫히면 영구 소실이라 막지 않고, 재수집만 상한을 건다 — 상한이
                # 없으면 한 회차에 전 명세서를 다시 받아 법원이 조용히 degrade한다(§4-3).
                needs_tenants = document_reader is not None and bid_key not in have_tenant_scan
                needs_upgrade = document_reader is not None and bid_key in need_rescan
                if bid_key in have_notice and not (needs_tenants or needs_upgrade):
                    skipped_existing += 1
                    continue
                (rescans if needs_upgrade and not needs_tenants else missing).append(
                    (row_index, row)
                )
            # 매각기일이 가까운 물건부터 받는다. 법원은 요청이 쌓이면 403이 아니라 **빈 응답**으로
            # 조용히 degrade한다(실측 2026-07-31: 180건 정상 뒤 287건 연속 빈 응답, 3시간 뒤 정상
            # 복구). 그 벽 너머로 밀린 물건은 그날 못 받는데, 명세서는 기일이 지나면 영구 소실이라
            # 검색 순서대로 돌면 가장 급한 물건이 가장 먼저 버려진다 (WP-11 §4-3).
            missing.sort(key=lambda pair: str(pair[1].get("maeGiil") or "99999999"))
            rescans.sort(key=lambda pair: str(pair[1].get("maeGiil") or "99999999"))
            # 재수집도 기일 임박순이다 — 창이 먼저 닫히는 것부터 고친다
            missing.extend(rescans[:rescan_limit])
            rescanned += len(rescans[:rescan_limit])
            if notice_limit is not None:
                missing = missing[: max(notice_limit - detailed, 0)]
            detailed += len(missing)
            try:
                batch = _collect_notices_for_rows(
                    run_id=run_id,
                    target=CollectionTarget(court_office_code=court),
                    client=counting,
                    indexed_rows=missing,
                    document_reader=counting_reader,
                )
                result = repository.upsert_notices(batch.notices)
            except BlockedByCourtError:
                raise
            except Exception as exc:  # 한 법원 실패가 다른 법원 명세서 수집을 막으면 안 된다
                stage_failures += 1
                logger.warning(
                    "daily_notices_court_failed run_id=%s court=%s error=%s", run_id, court, exc
                )
                continue
            notices_parsed += len(batch.notices)
            notice_unavailable += batch.unavailable
            notice_failed += batch.failed
            tenants_total += batch.tenant_rows
            tenants_rejected += batch.tenant_rejected
            notices_inserted += result.inserted
            notices_updated += result.updated
            notices_skipped += result.skipped
            notices_store_failed += result.failed
    logger.info(
        "daily_notices run_id=%s candidates=%s skipped_existing=%s detailed=%s rescanned=%s parsed=%s "
        "notice_unavailable=%s tenants=%s tenants_rejected=%s inserted=%s updated=%s "
        "skipped=%s store_failed=%s failed=%s requests=%s",
        run_id,
        candidates,
        skipped_existing,
        detailed,
        rescanned,
        notices_parsed,
        notice_unavailable,
        tenants_total,
        tenants_rejected,
        notices_inserted,
        notices_updated,
        notices_skipped,
        notices_store_failed,
        notice_failed,
        counting.requests - requests_start,
    )

    # 3단계 — 매각 결과 backfill: 기일이 지난 물건. 결과는 배당종결 전까지 받을 수 있어 덜 급하다.
    requests_start = counting.requests
    try:
        result = run_sale_result_backfill(
            run_id=run_id, client=counting, repository=repository, limit=backfill_limit
        )
        logger.info(
            "daily_results run_id=%s inserted=%s skipped=%s requests=%s",
            run_id,
            result.inserted,
            result.skipped,
            counting.requests - requests_start,
        )
    except BlockedByCourtError:
        raise
    except Exception as exc:
        stage_failures += 1
        logger.warning("daily_results_failed run_id=%s error=%s", run_id, exc)

    # 4단계 — 사진 수집: 창 제한이 없어 가장 덜 급하다.
    requests_start = counting.requests
    photo_court = court_office_codes[0] if len(court_office_codes) == 1 else None
    try:
        result = run_photo_collection(
            run_id=run_id,
            client=counting,
            repository=repository,
            court_office_code=photo_court,
            limit=photo_limit,
        )
        logger.info(
            "daily_photos run_id=%s inserted=%s updated=%s skipped=%s requests=%s",
            run_id,
            result.inserted,
            result.updated,
            result.skipped,
            counting.requests - requests_start,
        )
    except BlockedByCourtError:
        raise
    except Exception as exc:
        stage_failures += 1
        logger.warning("daily_photos_failed run_id=%s error=%s", run_id, exc)

    # 5단계 — 개인정보 마스킹: 법원 요청이 없어 맨 뒤에 둔다. 차단·스로틀로 앞 단계가 죽어도
    # 이건 돌아야 한다 — 파기 의무는 수집 성공 여부와 무관하다 (NF-03).
    try:
        masked = repository.mask_ended_case_tenant_names()
        remaining = repository.count_unmasked_tenant_names()
        # NF-03의 완료 기준이 "72시간 내 100%"라 감사 로그로 남긴다
        logger.info(
            "daily_masking run_id=%s masked=%s unmasked_remaining=%s", run_id, masked, remaining
        )
    except Exception as exc:
        stage_failures += 1
        logger.warning("daily_masking_failed run_id=%s error=%s", run_id, exc)

    summary = DailySummary(
        requests_total=counting.requests,
        notice_unavailable=notice_unavailable,
        stage_failures=stage_failures,
    )
    logger.info(
        "daily_done run_id=%s courts=%s notice_unavailable=%s stage_failures=%s requests_total=%s",
        run_id,
        ",".join(court_office_codes),
        summary.notice_unavailable,
        summary.stage_failures,
        summary.requests_total,
    )
    return summary
