import json

import pytest

from collector import court_client
from collector.court_client import BlockedByCourtError, CourtAuctionClient


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self) -> dict:
        return self._payload


def test_client_stops_immediately_on_block_response():
    calls: list[dict] = []

    def transport(url: str, payload: dict) -> FakeResponse:
        calls.append({"url": url, "payload": payload})
        return FakeResponse(403)

    client = CourtAuctionClient(
        base_url="https://www.courtauction.go.kr",
        request_interval_ms=0,
        max_retry=3,
        transport=transport,
    )

    with pytest.raises(BlockedByCourtError):
        client.search_items({"pageNo": 1})

    assert len(calls) == 1


def test_client_retries_transient_errors_then_returns_payload():
    statuses = [500, 502, 200]
    sleeps: list[int] = []

    def transport(url: str, payload: dict) -> FakeResponse:
        return FakeResponse(statuses.pop(0), {"data": {"totalCnt": 0, "items": []}})

    client = CourtAuctionClient(
        base_url="https://www.courtauction.go.kr",
        request_interval_ms=0,
        max_retry=3,
        transport=transport,
        sleep_ms=sleeps.append,
        # 백오프에 지터가 들어가므로 난수원을 고정해 결정적으로 본다.
        # 1.0이면 지터가 상한이라 지수 증가 그대로다 (jittered_ms 는 50~100%)
        rand=lambda: 1.0,
    )

    assert client.search_items({"pageNo": 1}) == {"data": {"totalCnt": 0, "items": []}}
    assert sleeps == [1500, 3000]


def test_client_wraps_transport_http_error_as_request_error():
    def transport(url: str, payload: dict) -> FakeResponse:
        raise OSError("HTTP Error 500: Internal Server Error")

    client = CourtAuctionClient(
        base_url="https://www.courtauction.go.kr",
        request_interval_ms=0,
        max_retry=1,
        transport=transport,
    )

    with pytest.raises(Exception, match="transport failed"):
        client.search_items({"pageNo": 1})


class _FakeUrlopenResponse:
    def __init__(self, payload: dict):
        self.status = 200
        self._body = json.dumps(payload).encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def test_urllib_transport_sends_real_courtauction_contract(monkeypatch):
    captured: dict = {}

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["headers"] = {k.lower(): v for k, v in req.headers.items()}
        return _FakeUrlopenResponse({"data": {}})

    monkeypatch.setattr(court_client.request, "urlopen", fake_urlopen)

    court_client._urllib_transport(
        "https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on",
        {"dma_pageInfo": {}},
    )

    assert captured["url"] == "https://www.courtauction.go.kr/pgj/pgjsearch/searchControllerMain.on"
    assert captured["headers"]["sc-userid"] == "SYSTEM"
    assert captured["headers"]["submissionid"] == court_client.SUBMISSION_ID
    assert captured["headers"]["referer"] == court_client.REFERER
    assert captured["headers"]["accept"] == "application/json"


def test_client_routes_each_search_method_to_its_endpoint():
    urls: list[str] = []

    def transport(url: str, payload: dict) -> FakeResponse:
        urls.append(url)
        return FakeResponse(200, {"data": {}})

    client = CourtAuctionClient(
        base_url="https://www.courtauction.go.kr",
        request_interval_ms=0,
        max_retry=1,
        transport=transport,
    )

    client.search_items({})
    client.search_sale_results({})
    client.search_case({})
    client.search_item_detail({})

    assert urls == [
        "https://www.courtauction.go.kr" + court_client.SEARCH_PATH,
        "https://www.courtauction.go.kr" + court_client.SALE_RESULT_PATH,
        "https://www.courtauction.go.kr" + court_client.CASE_SEARCH_PATH,
        "https://www.courtauction.go.kr" + court_client.ITEM_DETAIL_PATH,
    ]


def test_urllib_transport_switches_headers_by_endpoint(monkeypatch):
    captured: list[dict] = []

    def fake_urlopen(req, timeout):
        captured.append({k.lower(): v for k, v in req.headers.items()})
        return _FakeUrlopenResponse({"data": {}})

    monkeypatch.setattr(court_client.request, "urlopen", fake_urlopen)

    base = "https://www.courtauction.go.kr"
    court_client._urllib_transport(base + court_client.SALE_RESULT_PATH, {})
    court_client._urllib_transport(base + court_client.CASE_SEARCH_PATH, {})
    court_client._urllib_transport(base + court_client.ITEM_DETAIL_PATH, {})

    assert captured[0]["submissionid"] == court_client.SALE_RESULT_SUBMISSION_ID
    assert captured[0]["referer"] == court_client.SALE_RESULT_REFERER
    assert captured[1]["submissionid"] == court_client.CASE_SEARCH_SUBMISSION_ID
    assert captured[1]["referer"] == court_client.CASE_SEARCH_REFERER
    # 물건상세는 사건검색과 경로가 다르고 물건상세검색 화면에서 제출된다
    assert captured[2]["submissionid"] == court_client.ITEM_DETAIL_SUBMISSION_ID
    assert captured[2]["referer"] == court_client.REFERER


def test_client_jitters_the_request_interval():
    """요청 간격이 매번 같으면 그 자체가 기계 지문이라 차단 규칙에 걸린다 (D-007).

    설정값(1500)보다 빨라지지는 않는다 — 간격은 예절의 하한이다.
    """
    import random

    sleeps: list[int] = []

    def transport(url: str, payload: dict) -> FakeResponse:
        return FakeResponse(200, {"data": {"totalCnt": 0, "items": []}})

    client = CourtAuctionClient(
        base_url="https://www.courtauction.go.kr",
        request_interval_ms=1500,
        max_retry=3,
        transport=transport,
        sleep_ms=sleeps.append,
        rand=random.random,
    )
    for _ in range(30):
        client.search_items({"pageNo": 1})

    assert len(set(sleeps)) > 10, "간격이 흔들리지 않는다"
    assert all(1500 <= delay <= 2400 for delay in sleeps)
