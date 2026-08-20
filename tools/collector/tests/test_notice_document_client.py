# 명세서 문서 클라이언트 테스트 — PDF 취득 2단계와 차단 판정 (WP-11 §4-31)
import json

import pytest

from collector.court_client import BlockedByCourtError, CourtRequestError
from collector.notice_document_client import NoticeDocumentClient, NoticeDocumentSession

SESSION = NoticeDocumentSession(streamdocs_id="orig-1", access_token="token-1")
PDF = b"%PDF-1.4 fake body"


def _client(http_call):
    return NoticeDocumentClient(
        request_interval_ms=0,
        max_retry=3,
        http_call=http_call,
        sleep_ms=lambda _ms: None,
        rand=lambda: 0.0,
    )


def _recording(*, download_status=200, download_body=PDF):
    """(호출기록, http_call) — /changes 는 새 id를, 다운로드는 지정한 응답을 준다."""
    calls: list[dict] = []

    def http_call(url, headers, body, method):
        calls.append({"url": url, "headers": headers, "body": body, "method": method})
        if url.endswith("/changes"):
            return 200, json.dumps({"streamdocsId": "copy-1"}).encode()
        return download_status, download_body

    return calls, http_call


def test_fetch_pdf_asks_for_a_pdf_not_json():
    """다운로드 요청의 Accept 가 PDF 를 받아들여야 한다.

    회귀 가드: _urllib_call 이 모든 요청에 `Accept: application/json` 을 붙인다. PDF 를 달라면서
    JSON 만 받겠다고 보내면 서버가 **406 Not Acceptable** 로 거절한다. 실측 2026-08-21 03:22 —
    그날 명세서 74건이 전부 이 이유로 텍스트 레이어로 폴백했다.
    """
    calls, http_call = _recording()

    _client(http_call).fetch_pdf(SESSION)

    download = calls[-1]
    assert "application/pdf" in download["headers"]["Accept"]
    assert download["headers"]["Accept"] != "application/json"


def test_fetch_pdf_downloads_the_copy_not_the_original():
    """다운로드는 /changes 가 돌려준 **새 id** 로 한다.

    원본 id 를 직접 받으려 하면 거부된다 — 사본을 먼저 만드는 것이 뷰어의 정상 절차다.
    """
    calls, http_call = _recording()

    assert _client(http_call).fetch_pdf(SESSION) == PDF

    changes, download = calls[0], calls[-1]
    assert changes["method"] == "POST" and changes["url"].endswith("/documents/orig-1/changes")
    assert "/documents/copy-1" in download["url"]
    assert download["method"] == "GET"
    # 서명 토큰과 원본 id 가 쿼리에 실린다 (파라미터 이름은 난수라 값으로 확인하지 않는다)
    assert "originalId=orig-1" in download["url"]


def test_fetch_pdf_sends_no_watermark_changes():
    """변경 없는 사본만 요청한다 — 원본 문서를 바꾸지 않는다."""
    calls, http_call = _recording()

    _client(http_call).fetch_pdf(SESSION)

    assert calls[0]["body"]["watermark"] == []
    assert calls[0]["body"]["saveAsIncremental"] is True


def test_fetch_pdf_rejects_a_body_that_is_not_a_pdf():
    """법원이 차단 페이지(HTML)를 200 으로 돌려준 실측이 있다 — 그대로 저장하면 안 된다."""
    _, http_call = _recording(download_body=b"<br><center>blocked</center>")

    with pytest.raises(CourtRequestError, match="not a PDF"):
        _client(http_call).fetch_pdf(SESSION)


def test_fetch_pdf_stops_when_the_court_blocks():
    """403 이 두 번이면 차단으로 보고 올린다 — 우회하지 않는다 (D-007).

    한 번은 분 경계를 넘어 토큰이 만료됐을 수 있어 새로 계산해 재시도한다.
    """
    calls, http_call = _recording(download_status=403, download_body=b"")

    with pytest.raises(BlockedByCourtError):
        _client(http_call).fetch_pdf(SESSION)

    downloads = [c for c in calls if c["method"] == "GET"]
    assert len(downloads) == 2  # 재시도 1회까지만
