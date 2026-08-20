from __future__ import annotations

import json
import random
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib import request
from urllib.parse import urlsplit

from collector.backoff import backoff_delay_ms, interval_delay_ms, jittered_ms


SEARCH_PATH = "/pgj/pgjsearch/searchControllerMain.on"
SUBMISSION_ID = "mf_wfm_mainFrame_sbm_selectGdsDtlSrch"
REFERER = "https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml"

# 매각결과검색(PGJ158M00) — 매각기일 다음날부터 7일간의 결과만 제공하는 스냅샷 엔드포인트
SALE_RESULT_PATH = "/pgj/pgjsearch/selectDspslSchdRsltSrch.on"
SALE_RESULT_SUBMISSION_ID = "mf_wfm_mainFrame_sbm_selectDspslSchdRsltSrch"
SALE_RESULT_REFERER = (
    "https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ158M00.xml"
)

# 경매사건검색(PGJ159M00) — 진행 중 사건의 기일 이력·물건별 결과 (종국 사건은 조회 불가)
CASE_SEARCH_PATH = "/pgj/pgj15A/selectAuctnCsSrchRslt.on"
CASE_SEARCH_SUBMISSION_ID = "mf_wfm_mainFrame_sbm_selectAuctnCsSrchRslt"
CASE_SEARCH_REFERER = (
    "https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj15A/PGJ159M00.xml"
)

# 물건상세(PGJ15BM01) — 매각물건명세서 기재사항(최선순위 설정·인수권리·비고)이 이 응답에 들어 있다.
# 사건검색(pgj15A)과 이름은 같지만 경로·submissionid가 다른 별개 엔드포인트다.
ITEM_DETAIL_PATH = "/pgj/pgj15B/selectAuctnCsSrchRslt.on"
ITEM_DETAIL_SUBMISSION_ID = "mf_wfm_mainFrame_sbm_selectGdsDtlSrchDtlInfo"

# 사진조회(PGJ15BP06, 사진보기 팝업) — 사건 단위 사진 메타와 base64 바이트를 함께 준다.
# 브라우저는 이 요청에 sc-userid를 NONUSER로 보낸다 (다른 검색 엔드포인트는 SYSTEM).
PHOTO_PATH = "/pgj/pgj15B/selectPicInf.on"
PHOTO_SUBMISSION_ID = "mf_wfm_mainFrame_dspslGdsReltPicPopUp_wframe_sbm_selectPicInfoLst"

_DEFAULT_USERID = "SYSTEM"
_PHOTO_USERID = "NONUSER"

# 엔드포인트 경로별 WebSquare 제출 헤더 (submissionid, Referer, sc-userid) — 기본 transport가 참조한다
_ENDPOINT_HEADERS = {
    SEARCH_PATH: (SUBMISSION_ID, REFERER, _DEFAULT_USERID),
    SALE_RESULT_PATH: (SALE_RESULT_SUBMISSION_ID, SALE_RESULT_REFERER, _DEFAULT_USERID),
    CASE_SEARCH_PATH: (CASE_SEARCH_SUBMISSION_ID, CASE_SEARCH_REFERER, _DEFAULT_USERID),
    ITEM_DETAIL_PATH: (ITEM_DETAIL_SUBMISSION_ID, REFERER, _DEFAULT_USERID),
    PHOTO_PATH: (PHOTO_SUBMISSION_ID, REFERER, _PHOTO_USERID),
}


class BlockedByCourtError(RuntimeError):
    """차단 또는 접근제한 신호가 감지되면 우회하지 않고 즉시 중단한다."""


class CourtRequestError(RuntimeError):
    """재시도 후에도 법원 요청이 실패했을 때 발생한다."""


@dataclass(frozen=True)
class HttpResponse:
    status_code: int
    payload: dict[str, Any]

    def json(self) -> dict[str, Any]:
        return self.payload


Transport = Callable[[str, dict[str, Any]], Any]
SleepMs = Callable[[int], None]
Rand = Callable[[], float]


class CourtAuctionClient:
    def __init__(
        self,
        *,
        base_url: str,
        request_interval_ms: int,
        max_retry: int,
        transport: Transport | None = None,
        sleep_ms: SleepMs | None = None,
        rand: Rand | None = None,
    ) -> None:
        if request_interval_ms < 0:
            raise ValueError("request_interval_ms는 음수일 수 없습니다")
        if max_retry < 1:
            raise ValueError("max_retry는 1 이상이어야 합니다")

        self._base_url = base_url.rstrip("/")
        self._request_interval_ms = request_interval_ms
        self._max_retry = max_retry
        self._transport = transport or _urllib_transport
        self._sleep_ms = sleep_ms or _sleep_ms
        # 간격·백오프를 흔들 난수원. 테스트가 결정적으로 돌 수 있게 주입 가능하게 둔다
        self._rand = rand or random.random

    def search_items(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request(SEARCH_PATH, payload)

    def search_sale_results(self, payload: dict[str, Any]) -> dict[str, Any]:
        """매각결과검색(PGJ158M00)을 호출한다 — 최근 7일 매각/유찰 결과 스냅샷."""
        return self._request(SALE_RESULT_PATH, payload)

    def search_case(self, payload: dict[str, Any]) -> dict[str, Any]:
        """경매사건검색(PGJ159M00)을 호출한다 — 사건 단위 기일 이력·물건별 결과."""
        return self._request(CASE_SEARCH_PATH, payload)

    def search_item_detail(self, payload: dict[str, Any]) -> dict[str, Any]:
        """물건상세(PGJ15BM01)를 호출한다 — 매각물건명세서 기재사항이 함께 온다."""
        return self._request(ITEM_DETAIL_PATH, payload)

    def search_photos(self, payload: dict[str, Any]) -> dict[str, Any]:
        """사진조회(PGJ15BP06)를 호출한다 — 사건 단위 사진 메타와 base64 바이트."""
        return self._request(PHOTO_PATH, payload)

    def _request(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base_url}{path}"
        last_status: int | None = None

        for attempt in range(1, self._max_retry + 1):
            if attempt > 1:
                self._sleep_ms(jittered_ms(backoff_delay_ms(attempt - 1), rand=self._rand))
            elif self._request_interval_ms:
                self._sleep_ms(interval_delay_ms(self._request_interval_ms, rand=self._rand))

            try:
                response = self._transport(url, dict(payload))
            except OSError as exc:
                raise CourtRequestError(f"courtauction transport failed: {exc}") from exc
            status_code = int(response.status_code)
            last_status = status_code

            if status_code in {403, 429}:
                raise BlockedByCourtError(f"courtauction blocked collector: HTTP {status_code}")
            if 200 <= status_code < 300:
                return response.json()
            if status_code < 500:
                raise CourtRequestError(f"courtauction request failed: HTTP {status_code}")

        raise CourtRequestError(f"courtauction request failed after retries: HTTP {last_status}")


def _urllib_transport(url: str, payload: dict[str, Any]) -> HttpResponse:
    # 요청 경로에 맞는 submissionid/Referer/sc-userid를 고른다 (transport 시그니처는 기존 그대로 유지)
    submission_id, referer, sc_userid = _ENDPOINT_HEADERS.get(
        urlsplit(url).path, (SUBMISSION_ID, REFERER, _DEFAULT_USERID)
    )
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json;charset=UTF-8",
            "Accept": "application/json",
            "Referer": referer,
            "sc-userid": sc_userid,
            "submissionid": submission_id,
            "User-Agent": "real-estate-auction-collector/0.1",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=30) as response:  # noqa: S310 - configured public endpoint
        return HttpResponse(
            status_code=response.status,
            payload=json.loads(response.read().decode("utf-8")),
        )


def _sleep_ms(milliseconds: int) -> None:
    time.sleep(milliseconds / 1000)
