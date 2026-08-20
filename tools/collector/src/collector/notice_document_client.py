# 매각물건명세서 PDF 뷰어 경로 클라이언트 — 열람로그·뷰어정보·getPdf를 거쳐 텍스트 레이어를 받는다
from __future__ import annotations

import base64
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib import request

from collector.backoff import backoff_delay_ms
from collector.court_client import BlockedByCourtError, CourtRequestError
from collector.streamdocs_token import download_url


# 열람로그(courtauction) — 응답의 encParam이 이후 ecfs 요청의 열람 티켓이 된다
NOTICE_LOG_URL = "https://www.courtauction.go.kr/pgj/pgj15B/insertDspslGdsSpecArtcWdrwInf.on"
NOTICE_LOG_REFERER = (
    "https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ159M00.xml"
)
# 소송문서뷰어(ecfs)
DOC_VIEWER_INFO_URL = "https://ecfs.scourt.go.kr/sgvo/sgvomain/selectDocVwrInf.on"
GET_PDF_URL = "https://ecfs.scourt.go.kr/sgvo/sgvomain/getPdf.on"
# 문서 스트리밍(pvo) — 페이지별 텍스트 레이어(라인 + 문자 좌표)
TEXTS_URL = "https://pvo.scourt.go.kr/streamdocs/v4/documents/{doc_id}/texts/{page}"
# 저장(다운로드) 경로. 뷰어의 저장 버튼과 같은 2단계다 (WP-11 §4-31):
# 원본에 변경사항을 적용한 **사본**을 만들고, 그 새 id로 서명 토큰을 계산해 받는다.
# 원본 id를 직접 받으려 하면 거부된다.
STREAMDOCS_BASE = "https://pvo.scourt.go.kr/streamdocs/"
CHANGES_URL = STREAMDOCS_BASE + "v4/documents/{doc_id}/changes"
# 변경 없는 사본. 뷰어는 여기에 열람 도장을 싣지만 그 워터마크는 renderTarget=SCREEN(화면 전용)
# 이라 저장본에 들어가지 않는다 — 실측으로 저장본 텍스트 레이어에 워터마크 문구가 0건이다.
_NO_CHANGES: dict[str, Any] = {
    "layout": [], "annot": [], "acroform": [], "acroformProp": {"CO": []},
    "watermark": [], "outline": [], "saveAsIncremental": True,
}  # fmt: skip
TEXTS_REFERER = "https://pvo.scourt.go.kr/streamdocs/view/sd"

# 비로그인 열람자. 브라우저가 보내는 값과 같아야 한다 (수집기 기본값 SYSTEM과 다르다)
_NONUSER = "NONUSER"
_USER_AGENT = "real-estate-auction-collector/0.1"


@dataclass(frozen=True)
class NoticeDocumentRef:
    """물건상세 응답에서 그대로 얻는 명세서 문서 좌표 — 추가 조회가 필요 없다.

    `case_no`는 사람이 읽는 사건번호가 아니라 내부 표기(csNo, 예 20230130061278)다.
    `court_code`는 ecfs 쪽 6자리 코드(000211)로, 법원경매정보의 B000211과 접두사가 다르다.
    """

    court_office_code: str
    court_code: str
    case_no: str
    goods_seq: int
    ecdoc_id: str


@dataclass(frozen=True)
class NoticeDocumentSession:
    """getPdf가 발급한 문서 세션 — 문서 식별자와 pvo 접근 토큰."""

    streamdocs_id: str
    access_token: str


HttpCall = Callable[[str, dict[str, str], dict[str, Any] | None, str], tuple[int, bytes]]
SleepMs = Callable[[int], None]


def notice_document_ref(detail_payload: dict[str, Any]) -> NoticeDocumentRef | None:
    """물건상세(PGJ15BM01) 응답에서 명세서 문서 좌표를 뽑는다. 명세서가 없으면 None."""
    result = detail_payload.get("data", {})
    result = result.get("dma_result") if isinstance(result, dict) else None
    if not isinstance(result, dict):
        return None
    base = result.get("csBaseInfo")
    dxdy = result.get("dspslGdsDxdyInfo")
    if not isinstance(base, dict) or not isinstance(dxdy, dict):
        return None

    court_office_code = str(base.get("cortOfcCd") or "")
    case_no = str(base.get("csNo") or "")
    ecdoc_id = str(dxdy.get("dspslGdsSpcfcEcdocId") or "")
    goods_seq = dxdy.get("dspslGdsSeq")
    if not (court_office_code and case_no and ecdoc_id) or not isinstance(goods_seq, int):
        return None

    return NoticeDocumentRef(
        court_office_code=court_office_code,
        # ecfs는 법원코드에서 앞의 기관구분 문자를 뺀 값을 쓴다
        court_code=court_office_code.lstrip("B"),
        case_no=case_no,
        goods_seq=goods_seq,
        ecdoc_id=ecdoc_id,
    )


class NoticeDocumentClient:
    """명세서 PDF 텍스트 레이어를 받아오는 클라이언트.

    한 문서를 열 때 열람로그 → 뷰어정보 → getPdf로 3회, 이후 페이지마다 1회를 쓴다.
    법원 서버 요청이므로 호출 간격과 백오프는 기존 수집기와 같은 규칙을 따른다.
    """

    def __init__(
        self,
        *,
        request_interval_ms: int,
        max_retry: int,
        http_call: HttpCall | None = None,
        sleep_ms: SleepMs | None = None,
    ) -> None:
        if request_interval_ms < 0:
            raise ValueError("request_interval_ms는 음수일 수 없습니다")
        if max_retry < 1:
            raise ValueError("max_retry는 1 이상이어야 합니다")
        self._request_interval_ms = request_interval_ms
        self._max_retry = max_retry
        self._http_call = http_call or _urllib_call
        self._sleep_ms = sleep_ms or _sleep_ms

    def open_document(self, ref: NoticeDocumentRef) -> NoticeDocumentSession | None:
        """명세서 문서를 열어 pvo 접근 정보를 받는다. 열람 창이 아니면 None."""
        log = self._json(
            NOTICE_LOG_URL,
            headers={
                "Referer": NOTICE_LOG_REFERER,
                "sc-pgmid": "PGJ15AF01",
                "sc-userid": _NONUSER,
                "submissionid": "mf_wfm_mainFrame_sbm_dspslSpcfcViewOpen",
            },
            body={
                "dma_dspslGdsSpecLog": {
                    "cortOfcCd": ref.court_office_code,
                    "csNo": ref.case_no,
                    "dspslGdsSeq": ref.goods_seq,
                    "orvParam": "",
                    "dspslGdsSpcfcEcdocId": ref.ecdoc_id,
                    "cortAuctnMbrsId": _NONUSER,
                    "docFlag": "1",
                    "dspslDxdyPbancEcdocId": "",
                }
            },
        )
        info = _object_at(log, "dma_dspslSpcfcInfo")
        enc_param = str(info.get("encParam") or "")
        viewer_url = str(info.get("url") or "")
        if not enc_param or not viewer_url:
            return None

        viewer_referer = _viewer_referer(viewer_url, enc_param)
        # 뷰어정보 조회는 브라우저가 getPdf 앞에 반드시 보내는 단계다 — 응답 자체는 쓰지 않는다
        self._json(
            DOC_VIEWER_INFO_URL,
            headers={
                "Referer": viewer_referer,
                "sc-pgmid": "SGVO201",
                "sc-token": "NA",
                "submissionid": "mf_sbm_docVwr",
            },
            body={"dma_parm": _viewer_info_params(enc_param)},
        )

        pdf = self._json(
            GET_PDF_URL,
            headers={
                "Referer": viewer_referer,
                "sc-pgmid": "SGVO201",
                "sc-token": "NA",
                "sc-userid": _NONUSER,
                "submissionid": f"mf_tac_pdf_contents_1_1_{ref.ecdoc_id}_body_sbm_pdf",
            },
            body=_get_pdf_body(ref),
        )
        streamdocs_id = str(pdf.get("streamdocsId") or "")
        access_token = str(pdf.get("accessToken") or "")
        if not streamdocs_id or not access_token:
            return None
        return NoticeDocumentSession(streamdocs_id=streamdocs_id, access_token=access_token)

    def fetch_text_page(self, session: NoticeDocumentSession, page: int) -> list[Any]:
        """문서 한 페이지의 텍스트 레이어를 받는다 — 라인별 텍스트와 문자 좌표."""
        url = TEXTS_URL.format(doc_id=session.streamdocs_id, page=page)
        payload = self._request(
            url,
            headers={
                "Authorization": f"Access-Token {session.access_token}",
                "Referer": TEXTS_REFERER,
            },
            body=None,
            method="GET",
        )
        return payload if isinstance(payload, list) else []

    def fetch_pdf(self, session: NoticeDocumentSession) -> bytes:
        """명세서 PDF를 받는다 — 뷰어의 저장 버튼과 같은 2단계 (WP-11 §4-31).

        표 괘선은 PDF에만 있다. 텍스트 레이어로는 임차인의 행·사람을 못 가르므로
        (§4-30) 이 경로가 점유자 표의 기준이 된다.

        서명 토큰은 **분 단위로 바뀐다**. 분 경계를 넘어 거부되면 새로 계산해 한 번만
        다시 시도한다 — 시계 차이를 다루는 것이지 차단을 뚫는 것이 아니다.
        두 번째도 거부되면 차단으로 보고 올린다(D-007).
        """
        changes = self._json(
            CHANGES_URL.format(doc_id=session.streamdocs_id),
            headers={
                "Authorization": f"Access-Token {session.access_token}",
                "Referer": TEXTS_REFERER,
                "Origin": "https://pvo.scourt.go.kr",
            },
            body=_NO_CHANGES,
        )
        copy_id = str(changes.get("streamdocsId") or "")
        if not copy_id:
            raise CourtRequestError("changes did not return a document id")

        for attempt in (1, 2):
            url = download_url(
                STREAMDOCS_BASE, copy_id, original_id=session.streamdocs_id
            )
            try:
                pdf = self._bytes(url, session.access_token)
            except BlockedByCourtError:
                if attempt == 2:
                    raise
                continue  # 분 경계를 넘었을 수 있다 — 토큰을 새로 만들어 한 번만 재시도
            if not pdf.startswith(b"%PDF"):
                raise CourtRequestError(f"download returned {len(pdf)} bytes that are not a PDF")
            return pdf
        raise CourtRequestError("unreachable")

    def _bytes(self, url: str, access_token: str) -> bytes:
        """PDF처럼 JSON이 아닌 응답을 받는다. 간격·백오프·차단 판정은 _request와 같다."""
        headers = {
            "Authorization": f"Access-Token {access_token}",
            "Referer": TEXTS_REFERER,
        }
        last_status: int | None = None
        for attempt in range(1, self._max_retry + 1):
            if attempt > 1:
                self._sleep_ms(backoff_delay_ms(attempt - 1))
            elif self._request_interval_ms:
                self._sleep_ms(self._request_interval_ms)
            try:
                status_code, raw = self._http_call(url, headers, None, "GET")
            except OSError as exc:
                raise CourtRequestError(f"notice document transport failed: {exc}") from exc
            last_status = status_code
            if status_code in {403, 429}:
                raise BlockedByCourtError(f"court blocked collector: HTTP {status_code}")
            if 200 <= status_code < 300:
                return raw
            if status_code < 500:
                raise CourtRequestError(f"notice document request failed: HTTP {status_code}")
        raise CourtRequestError(f"notice document request failed after retries: HTTP {last_status}")

    def _json(self, url: str, *, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
        payload = self._request(url, headers=headers, body=body, method="POST")
        if not isinstance(payload, dict):
            raise CourtRequestError(f"unexpected response shape: {url}")
        data = payload.get("data")
        return data if isinstance(data, dict) else payload

    def _request(
        self,
        url: str,
        *,
        headers: dict[str, str],
        body: dict[str, Any] | None,
        method: str,
    ) -> Any:
        last_status: int | None = None
        for attempt in range(1, self._max_retry + 1):
            if attempt > 1:
                self._sleep_ms(backoff_delay_ms(attempt - 1))
            elif self._request_interval_ms:
                self._sleep_ms(self._request_interval_ms)

            try:
                status_code, raw = self._http_call(url, headers, body, method)
            except OSError as exc:
                raise CourtRequestError(f"notice document transport failed: {exc}") from exc

            last_status = status_code
            if status_code in {403, 429}:
                raise BlockedByCourtError(f"court blocked collector: HTTP {status_code}")
            if 200 <= status_code < 300:
                return json.loads(raw.decode("utf-8"))
            if status_code < 500:
                raise CourtRequestError(f"notice document request failed: HTTP {status_code}")

        raise CourtRequestError(f"notice document request failed after retries: HTTP {last_status}")


def _viewer_referer(viewer_url: str, enc_param: str) -> str:
    """뷰어 페이지 주소를 브라우저와 같은 방식으로 만든다 — ecfs 요청의 Referer로 쓰인다."""
    param_data = base64.b64encode(
        json.dumps(
            {"encParam": enc_param, "pspTkn": "NA", "pspSid": "NA"}, separators=(",", ":")
        ).encode("utf-8")
    ).decode("ascii")
    return f"{viewer_url}?paramData={param_data}"


def _viewer_info_params(enc_param: str) -> dict[str, str]:
    keys = (
        "cortCd", "csNo", "userId", "ticket", "docList", "encUserId", "userNm", "purposeCd",
        "docWriteNo", "rdngAplyTypCd", "rdngAplySeq", "pin", "fileEdmsDocId", "docNm",
        "comTaskTypCd", "aplyYmd", "pspTkn", "pspIp", "pspUrl", "lgnUrl", "mngrUserId",
    )  # fmt: skip
    params = dict.fromkeys(keys, "")
    params["encParam"] = enc_param
    params["sidParam"] = "NA"
    return params


def _get_pdf_body(ref: NoticeDocumentRef) -> dict[str, Any]:
    """getPdf 요청 본문. 빈 필드까지 브라우저와 같게 보내야 문서 식별자를 돌려준다."""
    return {
        "dma_srchEdms": {
            "ecdocId": ref.ecdoc_id,
            "ecdocDtlSeq": "1",
            "ecdocFileSeq": "",
            "dcmevdSeq": "",
            "csNo": ref.case_no,
            "rdngLimtFileYn": "",
            "extnlUserYn": "Y",
            "bubviewerYn": "N",
            "jobKind": "JH",
            "edmsUsePurpDvsCd": "",
            "fileEdmsDocId": "",
            "vwrSoltnDocId": "",
            # 열람제한 범위 06 = 매각물건명세서
            "rdngLimtScopDvsCd": "06",
            "pin": "",
            "urlDvs": "",
            "searDvs": "",
            "docNm": "매각물건명세서(신규작성,1)",
            "userId": _NONUSER,
            "cortCd": ref.court_code,
            "comTaskTypCd": "",
            "ecdocCrtHstDvsCd": "",
            "scPgmId": "",
            "docuStartPageNo": "",
            "docuLstPageNo": "",
            "docuPageNoYn": "",
            "csNoR": "",
            "cortCdR": "",
            "mngrUserId": "",
            "passFlag": "",
            "scinMode": "",
        },
        "dma_header": {
            "SC-Userid": _NONUSER,
            "SC-Pgmid": "SGVO201",
            "SC-Token": "NA",
            "LifeSpan": "",
            "SID": "",
        },
        "dma_downloadOtpt": {
            "cortCd": "", "ecdocId": "", "ecdocDtlSeq": "", "fileEdmsDocId": "", "userId": "",
            "systmCd": "SGV", "wmYn": "Y", "wmTyp": "0", "wmTxt": "", "wmTxtLog": "",
            "wmAlignment": "", "wmTxtRgst": "", "wmShowWhenDisplayingYn": "",
            "wmShowWhenPrintingYn": "", "ecdocFileCnt": "", "qrYn": "", "qrParam": "",
            "docIssuNo": "", "fileNm": "", "invrcdCrrctExstcYn": "", "invrcdObjcExstcYn": "",
            "trnscrCrrctExstcYn": "", "trnscrObjcExstcYn": "", "dcmevdYn": "N", "dcmevdSeq": "",
            "ecdocCrtHstDvsCd": "", "extnlUserYn": "", "readYn": "Y", "use": "",
        },  # fmt: skip
        "dma_downloadOtptDcmevd": dict.fromkeys(
            (
                "docuSeojWmText", "docuStartPageNo", "docuLstPageNo", "docuSeojWmTextYn",
                "docuSeojWmTextColor", "docuSeojWmImageYn", "docuSeojWmImageType",
            ),  # fmt: skip
            "",
        ),
    }


def _object_at(payload: dict[str, Any], key: str) -> dict[str, Any]:
    value = payload.get(key)
    return value if isinstance(value, dict) else {}


def _urllib_call(
    url: str, headers: dict[str, str], body: dict[str, Any] | None, method: str
) -> tuple[int, bytes]:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = request.Request(url, data=data, method=method)  # noqa: S310 - configured court endpoints
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", _USER_AGENT)
    if data is not None:
        req.add_header("Content-Type", "application/json;charset=UTF-8")
    for name, value in headers.items():
        req.add_header(name, value)
    with request.urlopen(req, timeout=30) as response:  # noqa: S310
        return response.status, response.read()


def _sleep_ms(milliseconds: int) -> None:
    time.sleep(milliseconds / 1000)
