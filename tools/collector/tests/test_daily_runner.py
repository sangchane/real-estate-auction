# daily 실행 로직 테스트 — 전 페이지 순회, 명세서 스킵 필터, 단계 실패 계속, 차단 즉시 중단, 점유자 기본 비활성
import json
import logging
from dataclasses import replace
from pathlib import Path

import pytest

from collector.__main__ import DAILY_DEFAULT_COURTS, _daily_arg_parser
from collector.court_client import BlockedByCourtError, CourtRequestError
from collector.court_parser import ItemNotice, parse_search_page
from collector.notice_pdf_reader import PdfReadError
from collector.notice_document_client import NoticeDocumentSession
from collector.repository import (
    InMemoryAuctionRepository,
    InMemoryNoticeRepository,
    InMemoryPhotoRepository,
    InMemorySaleResultRepository,
)
from collector.runner import NOTICE_PROGRESS_EVERY, UNAVAILABLE_STREAK_LIMIT, run_daily


DETAIL_FIXTURE = Path(__file__).parent / "fixtures" / "court_item_detail_page.json"
TEXTS_FIXTURE = Path(__file__).parent / "fixtures" / "notice_pdf_texts_page0.json"

EMPTY_PHOTO_RESPONSE = {
    "data": {"dma_pageInfo": {"pageNo": 1, "totalCnt": "0"}, "dlt_csPicLst": [], "picLst": []}
}


def _row(court: str, case_no: str, item_no: str = "1") -> dict:
    return {"boCd": court, "srnSaNo": case_no, "maemulSer": item_no, "mokmulSer": item_no}


def _search_response(rows: list[dict], *, page_no: int, total: str) -> dict:
    # totalCnt는 1페이지(totalYn=Y)에만 오고 이후 페이지는 빈값이다 — 실서버 계약과 같게 만든다
    return {
        "status": 200,
        "data": {
            "dma_pageInfo": {"pageNo": page_no, "totalCnt": total},
            "dlt_srchResult": rows,
        },
    }


def _notice(court: str, case_no: str, item_no: str = "1") -> ItemNotice:
    return ItemNotice(
        court_office_code=court,
        case_no=case_no,
        item_no=item_no,
        document_date=None,
        baseline_raw="2020.01.01. 근저당권",
        baseline_date=None,
        distribution_demand_deadline=None,
        assumed_rights_kind=None,
        risk_flags=[],
        lien_claim_amount=None,
    )


class FakeDailyClient:
    """법원 4종 요청을 흉내낸다 — 검색 페이지 시나리오는 법원별 응답 목록으로 주입한다."""

    def __init__(self, pages_by_court: dict[str, list[dict]]):
        self._pages_by_court = pages_by_court
        self.search_pages: list[tuple[str, int]] = []
        self.detail_cases: list[str] = []
        self.case_searches: list[str] = []
        self.photo_searches: list[str] = []

    def search_items(self, payload: dict) -> dict:
        court = payload["dma_srchGdsDtlSrchInfo"]["cortOfcCd"]
        page_no = payload["dma_pageInfo"]["pageNo"]
        self.search_pages.append((court, page_no))
        return self._pages_by_court[court][page_no - 1]

    def search_item_detail(self, payload: dict) -> dict:
        self.detail_cases.append(payload["dma_srchGdsDtlSrch"]["csNo"])
        return json.loads(DETAIL_FIXTURE.read_text(encoding="utf-8"))

    def search_case(self, payload: dict) -> dict:
        self.case_searches.append(payload["dma_srchCsDtlInf"]["csNo"])
        return {"status": 200, "data": {}}  # 종국 등 — 결과 행 없음

    def search_photos(self, payload: dict) -> dict:
        self.photo_searches.append(payload["dma_srchPicInf"]["csNo"])
        return EMPTY_PHOTO_RESPONSE


class FakeDailyRepository:
    """네 저장소 프로토콜을 한 객체로 합친다 — PostgresAuctionRepository와 같은 사용면."""

    def __init__(self, pending_sale=None, missing_photos=None, ended_item_keys=None):
        self._items = InMemoryAuctionRepository()
        self._notice_repo = InMemoryNoticeRepository(ended_item_keys)
        self._sale = InMemorySaleResultRepository(pending_sale)
        self._photos = InMemoryPhotoRepository(missing_photos)

    def upsert_items(self, items):
        return self._items.upsert_items(items)

    def upsert_notices(self, notices):
        return self._notice_repo.upsert_notices(notices)

    def find_item_keys_with_notice(self):
        return self._notice_repo.find_item_keys_with_notice()

    def find_item_keys_with_tenant_scan(self):
        return self._notice_repo.find_item_keys_with_tenant_scan()

    def mask_ended_case_tenant_names(self):
        return self._notice_repo.mask_ended_case_tenant_names()

    def count_unmasked_tenant_names(self):
        return self._notice_repo.count_unmasked_tenant_names()

    def find_items_pending_sale_result(self):
        return self._sale.find_items_pending_sale_result()

    def upsert_sale_results(self, results):
        return self._sale.upsert_sale_results(results)

    def find_cases_missing_photos(self, court_office_code=None):
        return self._photos.find_cases_missing_photos(court_office_code)

    def upsert_case_photos(self, court_office_code, case_no, photos):
        return self._photos.upsert_case_photos(court_office_code, case_no, photos)

    @property
    def notices(self):
        return self._notice_repo.notices


def _run(client, repository, **kwargs):
    return run_daily(
        run_id="run-daily",
        court_office_codes=kwargs.pop("court_office_codes", ["B000210"]),
        client=client,
        repository=repository,
        parse_search_page=parse_search_page,
        **kwargs,
    )


def test_daily_walks_all_search_pages_until_total_count(caplog):
    caplog.set_level(logging.INFO)
    court = "B000210"
    pages = [
        _search_response(
            [_row(court, f"2024타경{i}") for i in range(1, 11)], page_no=1, total="25"
        ),
        _search_response(
            [_row(court, f"2024타경{i}") for i in range(11, 21)], page_no=2, total=""
        ),
        _search_response(
            [_row(court, f"2024타경{i}") for i in range(21, 26)], page_no=3, total=""
        ),
    ]
    client = FakeDailyClient({court: pages})
    repository = FakeDailyRepository()

    summary = _run(client, repository)

    # totalCnt=25 → 3페이지에서 종료. 마지막 페이지 뒤를 더 요청하지 않는다
    assert client.search_pages == [(court, 1), (court, 2), (court, 3)]
    # 새 물건 25건 전부 명세서 상세조회 → 저장
    assert len(client.detail_cases) == 25
    assert len(repository.notices) == 25
    # 요청 총합 = 검색 3 + 상세 25 (결과·사진 대상 없음)
    assert summary.requests_total == 28
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "daily_items run_id=run-daily courts=1 pages=3 processed=25" in messages
    assert "requests_total=28" in messages


def test_daily_respects_max_search_pages():
    court = "B000210"
    pages = [
        _search_response(
            [_row(court, f"2024타경{i}") for i in range(1, 11)], page_no=1, total="25"
        ),
    ]
    client = FakeDailyClient({court: pages})

    _run(client, FakeDailyRepository(), max_search_pages=1)

    assert client.search_pages == [(court, 1)]


def test_daily_collects_both_courts():
    pages_a = [_search_response([_row("B000210", "2024타경1")], page_no=1, total="1")]
    pages_b = [_search_response([_row("B000211", "2024타경2")], page_no=1, total="1")]
    client = FakeDailyClient({"B000210": pages_a, "B000211": pages_b})

    _run(client, FakeDailyRepository(), court_office_codes=["B000210", "B000211"])

    assert client.search_pages == [("B000210", 1), ("B000211", 1)]
    assert sorted(client.detail_cases) == ["2024타경1", "2024타경2"]


def test_daily_skips_detail_for_items_already_having_notice(caplog):
    caplog.set_level(logging.INFO)
    court = "B000210"
    rows = [_row(court, "2023타경100"), _row(court, "2023타경200")]
    client = FakeDailyClient({court: [_search_response(rows, page_no=1, total="2")]})
    repository = FakeDailyRepository()
    # 2023타경100은 이미 명세서 보유 — 상세조회 없이 건너뛴다 (요청 낭비 제거)
    repository.upsert_notices([_notice(court, "2023타경100")])

    _run(client, repository)

    assert client.detail_cases == ["2023타경200"]
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "skipped_existing=1" in messages
    assert "detailed=1" in messages


def test_daily_second_run_details_nothing():
    court = "B000210"
    rows = [_row(court, "2023타경100"), _row(court, "2023타경200")]
    pages = [_search_response(rows, page_no=1, total="2")]
    repository = FakeDailyRepository()

    first_client = FakeDailyClient({court: pages})
    _run(first_client, repository)
    second_client = FakeDailyClient({court: pages})
    _run(second_client, repository)

    # 첫 실행에서 명세서를 받았으므로 두 번째 실행은 상세조회가 0건이어야 한다
    assert len(first_client.detail_cases) == 2
    assert second_client.detail_cases == []


def test_daily_respects_notice_limit():
    court = "B000210"
    rows = [_row(court, f"2024타경{i}") for i in range(1, 6)]
    client = FakeDailyClient({court: [_search_response(rows, page_no=1, total="5")]})

    _run(client, FakeDailyRepository(), notice_limit=2)

    assert len(client.detail_cases) == 2


def test_daily_counts_items_whose_notice_is_unavailable(caplog):
    caplog.set_level(logging.INFO)
    court = "B000210"

    class EmptyDetailClient(FakeDailyClient):
        def search_item_detail(self, payload: dict) -> dict:
            self.detail_cases.append(payload["dma_srchGdsDtlSrch"]["csNo"])
            # 기일이 지난 물건의 실측 응답 — dma_result가 빈 객체로 온다 (WP-11 §4-3)
            return {"status": 200, "data": {"dma_result": {}}}

    client = EmptyDetailClient(
        {court: [_search_response([_row(court, "2023타경300")], page_no=1, total="1")]}
    )

    summary = _run(client, FakeDailyRepository())

    assert summary.notice_unavailable == 1
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "notice_unavailable=1" in messages
    assert "notice_item_unavailable" in messages


def test_daily_continues_to_next_stage_after_stage_failure(caplog):
    caplog.set_level(logging.INFO)
    court = "B000210"

    class BrokenSaleRepository(FakeDailyRepository):
        def find_items_pending_sale_result(self):
            raise RuntimeError("db down")

    client = FakeDailyClient(
        {court: [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]}
    )
    repository = BrokenSaleRepository(
        missing_photos=[{"court_office_code": court, "case_no": "2024타경1"}]
    )

    summary = _run(client, repository)

    # 3단계(결과) 실패에도 4단계(사진)는 계속 돈다
    assert client.photo_searches == ["20240130000001"]
    assert summary.stage_failures == 1
    assert "daily_results_failed" in "\n".join(r.getMessage() for r in caplog.records)


def test_daily_continues_to_other_court_and_stages_after_search_failure(caplog):
    caplog.set_level(logging.INFO)

    class FailingSearchClient(FakeDailyClient):
        def search_items(self, payload: dict) -> dict:
            if payload["dma_srchGdsDtlSrchInfo"]["cortOfcCd"] == "B000210":
                raise CourtRequestError("courtauction request failed: HTTP 400")
            return super().search_items(payload)

    client = FailingSearchClient(
        {"B000211": [_search_response([_row("B000211", "2024타경2")], page_no=1, total="1")]}
    )

    summary = _run(client, FakeDailyRepository(), court_office_codes=["B000210", "B000211"])

    # 서울중앙 검색 실패에도 서울동부 수집·명세서는 계속된다
    assert client.detail_cases == ["2024타경2"]
    assert summary.stage_failures == 1
    assert "daily_items_court_failed" in "\n".join(r.getMessage() for r in caplog.records)


def test_daily_aborts_all_stages_on_block_signal():
    court = "B000210"

    class BlockedDetailClient(FakeDailyClient):
        def search_item_detail(self, payload: dict) -> dict:
            raise BlockedByCourtError("courtauction blocked collector: HTTP 403")

    client = BlockedDetailClient(
        {court: [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]}
    )
    repository = FakeDailyRepository(
        pending_sale=[{"court_office_code": court, "case_no": "2024타경1", "item_no": "1"}],
        missing_photos=[{"court_office_code": court, "case_no": "2024타경1"}],
    )

    with pytest.raises(BlockedByCourtError):
        _run(client, repository)

    # 차단 신호는 즉시 전체 중단 — 이후 단계(결과·사진)는 요청하지 않는다
    assert client.case_searches == []
    assert client.photo_searches == []


class FakeDocumentReader:
    """명세서 PDF 경로를 흉내낸다 — 문서 열기 1회, 페이지별 텍스트 1회."""

    def __init__(self):
        self.opened: list[str] = []

    def open_document(self, ref):
        self.opened.append(ref.ecdoc_id)
        return NoticeDocumentSession(streamdocs_id="doc-1", access_token="token-1")

    def fetch_pdf(self, session) -> bytes:
        # 이 더블은 **텍스트 레이어 폴백 경로**를 검사한다. PDF 경로는 별도 테스트에서 본다.
        raise PdfReadError("fake reader has no pdf")

    def fetch_text_page(self, session, page: int):
        if page == 0:
            return json.loads(TEXTS_FIXTURE.read_text(encoding="utf-8"))
        return []


def test_daily_reads_tenant_documents_only_when_reader_given():
    court = "B000210"
    pages = [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]
    reader = FakeDocumentReader()

    # 기본(reader 없음) — 문서 경로를 아예 타지 않는다
    no_reader_summary = _run(FakeDailyClient({court: pages}), FakeDailyRepository())
    assert reader.opened == []
    # 검색 1 + 상세 1 (문서 요청 없음)
    assert no_reader_summary.requests_total == 2

    with_reader_summary = _run(
        FakeDailyClient({court: pages}), FakeDailyRepository(), document_reader=reader
    )
    assert len(reader.opened) == 1
    # 검색 1 + 상세 1 + 문서 열기 3 + PDF 2(사본+다운로드) + 텍스트 1쪽 1.
    # 이 더블은 PDF 를 못 읽어 텍스트 레이어로 폴백하므로 두 경로의 요청이 모두 세어진다
    assert with_reader_summary.requests_total == 8


def test_daily_reopens_notice_that_has_no_tenant_scan_yet():
    """기재사항만 받아둔 물건은 명세서 보유로 스킵하면 안 된다 — 표는 기일이 지나면 영구 소실된다."""
    court = "B000210"
    pages = [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]
    repository = FakeDailyRepository()
    # 어제 --with-tenants 없이 돌아 기재사항만 들어온 상태
    repository.upsert_notices([_notice(court, "2024타경1")])
    reader = FakeDocumentReader()

    client = FakeDailyClient({court: pages})
    _run(client, repository, document_reader=reader)

    assert client.detail_cases == ["2024타경1"]
    assert len(reader.opened) == 1


def test_daily_does_not_reopen_documents_already_scanned():
    """스캔이 끝난 물건은 다시 열지 않는다 — 안 그러면 물건당 3요청 이상을 매일 되쓴다."""
    court = "B000210"
    pages = [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]
    repository = FakeDailyRepository()
    reader = FakeDocumentReader()

    _run(FakeDailyClient({court: pages}), repository, document_reader=reader)
    second_client = FakeDailyClient({court: pages})
    _run(second_client, repository, document_reader=reader)

    assert len(reader.opened) == 1
    assert second_client.detail_cases == []


def test_daily_marks_scan_even_when_table_is_empty():
    """법원이 '조사된 임차내역없음'이라 적은 문서도 스캔으로 친다 — 안 그러면 영원히 다시 연다."""
    court = "B000210"
    pages = [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]

    class EmptyTableReader(FakeDocumentReader):
        def fetch_text_page(self, session, page: int):
            return []  # 점유자 행이 하나도 안 잡히는 문서

    repository = FakeDailyRepository()
    reader = EmptyTableReader()

    _run(FakeDailyClient({court: pages}), repository, document_reader=reader)
    assert repository.find_item_keys_with_tenant_scan() == {(court, "2024타경1", "1", None)}
    # 행이 아예 없는 문서는 버림 0으로 확정된다 — "임차인 없음"으로 믿어도 되는 근거 (§4-7)
    assert next(iter(repository.notices.values())).tenants_rejected == 0

    second_client = FakeDailyClient({court: pages})
    _run(second_client, repository, document_reader=reader)
    assert len(reader.opened) == 1


def test_daily_records_rejected_row_count():
    """게이트가 행을 버린 문서는 버림 수가 남는다 — '임차인 없음'과 구분하는 표시다 (§4-7)."""
    court = "B000210"
    pages = [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]

    class RejectedRowReader(FakeDocumentReader):
        def fetch_text_page(self, session, page: int):
            if page == 0:
                # 실측 문서 — 행 3개 중 1개(전입일·보증금 모두 미상)가 게이트에서 버려진다
                fixture = TEXTS_FIXTURE.parent / "notice_pdf_texts_52802_2.json"
                return json.loads(fixture.read_text(encoding="utf-8"))
            return []

    repository = FakeDailyRepository()
    _run(FakeDailyClient({court: pages}), repository, document_reader=RejectedRowReader())

    stored = next(iter(repository.notices.values()))
    assert len(stored.tenants) == 2
    assert stored.tenants_rejected == 1


def test_daily_keeps_scan_mark_when_rerun_without_tenants():
    """표 없이 재수집해도 스캔 기록은 남는다 — 지워지면 다음 실행이 문서를 헛되이 다시 연다."""
    court = "B000210"
    pages = [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]
    repository = FakeDailyRepository()
    reader = FakeDocumentReader()

    _run(FakeDailyClient({court: pages}), repository, document_reader=reader)
    stored = next(iter(repository.notices.values()))
    assert stored.tenants_scanned
    assert stored.tenants_rejected == 0

    # 표를 안 받는 실행 — 같은 명세서(같은 작성일)를 표 없이 다시 저장한다
    repository.upsert_notices(
        [replace(stored, tenants=(), tenants_scanned=False, tenants_rejected=None)]
    )

    assert repository.find_item_keys_with_tenant_scan() == {(court, "2024타경1", "1", None)}
    # 버림 수도 스캔 표시와 함께 살아남아야 한다 — 지워지면 H3가 그 물건의 품질을 다시 모른다
    assert next(iter(repository.notices.values())).tenants_rejected == 0


def test_daily_refetches_notice_when_bid_date_rolled_over():
    """유찰로 기일이 바뀌면 그 기일의 명세서를 새로 받는다 — 명세서는 기일마다 새로 작성된다."""
    court = "B000210"
    first_rows = [{**_row(court, "2024타경1"), "maeGiil": "20260803"}]
    later_rows = [{**_row(court, "2024타경1"), "maeGiil": "20260907"}]
    repository = FakeDailyRepository()
    reader = FakeDocumentReader()

    _run(
        FakeDailyClient({court: [_search_response(first_rows, page_no=1, total="1")]}),
        repository,
        document_reader=reader,
    )
    rolled = FakeDailyClient({court: [_search_response(later_rows, page_no=1, total="1")]})
    _run(rolled, repository, document_reader=reader)

    # 8/3 명세서를 갖고 있어도 9/7 기일 것은 없다 — 다시 받아야 한다
    assert rolled.detail_cases == ["2024타경1"]
    assert len(reader.opened) == 2


def test_daily_skips_when_bid_date_unchanged():
    """기일이 그대로면 다시 받지 않는다 — 매일 전부 다시 여는 낭비를 막는 조건이다."""
    court = "B000210"
    rows = [{**_row(court, "2024타경1"), "maeGiil": "20260803"}]
    pages = [_search_response(rows, page_no=1, total="1")]
    repository = FakeDailyRepository()
    reader = FakeDocumentReader()

    _run(FakeDailyClient({court: pages}), repository, document_reader=reader)
    second = FakeDailyClient({court: pages})
    _run(second, repository, document_reader=reader)

    assert second.detail_cases == []
    assert len(reader.opened) == 1


def test_daily_details_nearest_bid_date_first():
    """기일이 가까운 물건부터 상세조회한다 — 법원이 조용히 빈 응답을 주기 시작하면 뒤쪽은 못 받는다."""
    court = "B000210"
    rows = [
        {**_row(court, "2024타경300"), "maeGiil": "20260910"},
        {**_row(court, "2024타경100"), "maeGiil": "20260803"},
        {**_row(court, "2024타경200"), "maeGiil": "20260825"},
        {**_row(court, "2024타경400")},  # 기일 없음 — 맨 뒤로
    ]
    client = FakeDailyClient({court: [_search_response(rows, page_no=1, total="4")]})

    _run(client, FakeDailyRepository())

    assert client.detail_cases == ["2024타경100", "2024타경200", "2024타경300", "2024타경400"]


def test_daily_notice_limit_keeps_most_urgent():
    """상한이 걸리면 기일이 가장 가까운 것부터 남긴다 — 상한은 급한 걸 버리는 장치가 아니다."""
    court = "B000210"
    rows = [
        {**_row(court, "2024타경300"), "maeGiil": "20260910"},
        {**_row(court, "2024타경100"), "maeGiil": "20260803"},
        {**_row(court, "2024타경200"), "maeGiil": "20260825"},
    ]
    client = FakeDailyClient({court: [_search_response(rows, page_no=1, total="3")]})

    _run(client, FakeDailyRepository(), notice_limit=2)

    assert client.detail_cases == ["2024타경100", "2024타경200"]


def test_daily_masks_tenant_names_of_ended_cases(caplog):
    """배당종결된 사건의 점유자 성명을 지운다 (NF-03) — 파기는 법적 의무다."""
    caplog.set_level(logging.INFO)
    court = "B000210"
    pages = [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]
    repository = FakeDailyRepository(ended_item_keys={(court, "2024타경1", "1")})
    reader = FakeDocumentReader()

    _run(FakeDailyClient({court: pages}), repository, document_reader=reader)

    assert repository.count_unmasked_tenant_names() == 0
    messages = "\n".join(r.getMessage() for r in caplog.records)
    assert "daily_masking" in messages
    assert "unmasked_remaining=0" in messages


def test_daily_keeps_tenant_names_while_case_is_open():
    """진행 중 사건의 성명은 지우지 않는다 — 지우면 재수집도 못 하고 되돌릴 수 없다."""
    court = "B000210"
    pages = [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]
    repository = FakeDailyRepository()  # 종료된 사건 없음
    reader = FakeDocumentReader()

    _run(FakeDailyClient({court: pages}), repository, document_reader=reader)

    assert repository.count_unmasked_tenant_names() > 0


def test_daily_masking_runs_even_when_earlier_stage_fails(caplog):
    """앞 단계가 죽어도 마스킹은 돈다 — 파기 의무는 수집 성공 여부와 무관하다."""
    caplog.set_level(logging.INFO)
    court = "B000210"

    class BrokenPhotoRepository(FakeDailyRepository):
        def find_cases_missing_photos(self, court_office_code=None):
            raise RuntimeError("db down")

    repository = BrokenPhotoRepository(ended_item_keys={(court, "2024타경1", "1")})
    client = FakeDailyClient(
        {court: [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]}
    )

    summary = _run(client, repository, document_reader=FakeDocumentReader())

    assert summary.stage_failures == 1  # 사진 단계만 실패
    assert repository.count_unmasked_tenant_names() == 0
    assert "daily_masking" in "\n".join(r.getMessage() for r in caplog.records)


def test_daily_stops_a_court_after_a_long_unavailable_streak(caplog):
    """명세서가 연속으로 비면 스로틀로 보고 그 법원을 중단한다 (WP-11 §4-10).

    실측: 180건 정상 뒤 287건이 연속으로 비었고 3시간 뒤 정상 복구됐다. 계속 돌아봐야 빈 응답만
    받으므로 멈추는 게 맞다 — 명세서 행이 안 생기니 다음 실행이 자동으로 재시도한다.
    """
    caplog.set_level(logging.INFO)
    court = "B000210"
    total = UNAVAILABLE_STREAK_LIMIT + 15
    rows = [_row(court, f"2024타경{i}") for i in range(1, total + 1)]

    class AlwaysEmptyDetailClient(FakeDailyClient):
        def search_item_detail(self, payload: dict) -> dict:
            self.detail_cases.append(payload["dma_srchGdsDtlSrch"]["csNo"])
            return {"status": 200, "data": {"dma_result": {}}}

    client = AlwaysEmptyDetailClient(
        {court: [_search_response(rows, page_no=1, total=str(total))]}
    )

    _run(client, FakeDailyRepository())

    # 상한에서 멈춘다 — 남은 15건은 요청하지 않는다
    assert len(client.detail_cases) == UNAVAILABLE_STREAK_LIMIT
    assert "notice_throttle_suspected" in "\n".join(r.getMessage() for r in caplog.records)


def test_daily_streak_resets_on_a_successful_notice():
    """중간에 하나라도 성공하면 연속 카운터가 초기화된다 — 드문드문 빈 것은 스로틀이 아니다."""
    court = "B000210"
    # 빈 응답 사이에 성공을 끼워 넣으면 상한에 도달하지 않아 전부 조회한다
    total = UNAVAILABLE_STREAK_LIMIT + 5
    rows = [_row(court, f"2024타경{i}") for i in range(1, total + 1)]

    class AlternatingClient(FakeDailyClient):
        def search_item_detail(self, payload: dict) -> dict:
            self.detail_cases.append(payload["dma_srchGdsDtlSrch"]["csNo"])
            # 10건마다 한 번은 정상 응답
            if len(self.detail_cases) % 10 == 0:
                return json.loads(DETAIL_FIXTURE.read_text(encoding="utf-8"))
            return {"status": 200, "data": {"dma_result": {}}}

    client = AlternatingClient({court: [_search_response(rows, page_no=1, total=str(total))]})

    _run(client, FakeDailyRepository())

    assert len(client.detail_cases) == total


def test_daily_logs_notice_progress(caplog):
    """명세서 단계가 살아 있는지 로그로 알 수 있어야 한다.

    성공한 물건은 로그하지 않아서 정상 동작 중일수록 조용하다 — 수백 건이면 수십 분간 무음이라
    죽은 것과 구분되지 않는다(2026-08-04에 이것 때문에 세 번 오판했다).
    """
    caplog.set_level(logging.INFO)
    court = "B000210"
    total = NOTICE_PROGRESS_EVERY * 2
    rows = [_row(court, f"2024타경{i}") for i in range(1, total + 1)]
    client = FakeDailyClient({court: [_search_response(rows, page_no=1, total=str(total))]})

    _run(client, FakeDailyRepository())

    messages = [r.getMessage() for r in caplog.records if "notice_progress" in r.getMessage()]
    assert len(messages) == 2  # 25건마다 한 줄
    assert f"{NOTICE_PROGRESS_EVERY}/{total}" in messages[0]


def test_daily_cli_defaults_two_courts_and_tenants_disabled():
    args = _daily_arg_parser().parse_args([])

    assert args.with_tenants is False
    assert args.court_office_code is None
    assert args.notice_limit is None
    # 서울 5개 지방법원. B000214는 의정부라 뺐다 (실측 확인 2026-08-04)
    assert DAILY_DEFAULT_COURTS == ["B000210", "B000211", "B000212", "B000213", "B000215"]


def test_daily_photo_stage_reuses_photo_runner():
    court = "B000210"
    client = FakeDailyClient(
        {court: [_search_response([_row(court, "2024타경1")], page_no=1, total="1")]}
    )
    repository = FakeDailyRepository(
        missing_photos=[{"court_office_code": court, "case_no": "2024타경1"}]
    )

    summary = _run(client, repository, photo_limit=1)

    assert client.photo_searches == ["20240130000001"]
    assert summary.stage_failures == 0
