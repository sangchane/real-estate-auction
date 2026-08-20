# ePapyrus StreamDocs 문서뷰어의 PDF 다운로드 서명 토큰을 재현하는 순수 함수 (뷰어 chunk-NQ3JAQ6X.js 이식)
"""법원 문서뷰어가 다운로드 URL에 붙이는 서명 토큰을 파이썬으로 재현한다.

토큰 = XOR( base64( SHA-512( <분단위내림 epoch ms 문자열> + docId ) ), 하드코딩키 )
관측값 재현 확인: docId=P0jxZEDgWK_MYVyA1Fd73QuKhQW51O4WFJr5NjSsL1I,
분=1787203680000ms(2026-08-20 14:28:00 KST)에서 관측 토큰과 일치.
네트워크·전역상태를 쓰지 않는다(표준 라이브러리만).
"""

import base64
import hashlib
import secrets
import time

# 뷰어가 하드코딩한 XOR 키(A0OTMwODA1). 64바이트 base64 — SHA-512 다이제스트와 같은 길이라
# noBypass 경로에서 다이제스트 전체를 한 겹 XOR 한다.
_XOR_KEY_B64 = "AZsCErpKMi90AHruj94DUc7vjafUVyowwStODTNPMDdEYV0rZVQ8xsuHLlmGwEx0HM6M8IkSKt9yCSzj+5W0ZA=="

# 분 경계(ms). setSeconds(0,0)은 초·밀리초를 0으로 만든 epoch ms를 돌려주는데, 분은
# 시간대와 무관하게 전 세계가 동일한 60000ms 격자에 정렬되므로 나머지 절삭과 같다.
_MINUTE_MS = 60_000


def _minute_floor_ms(at_ms: int, time_offset_ms: int) -> int:
    """Date.now()+offset 을 분 단위로 내린 epoch ms. 뷰어의 EyNTI4ODgw 재현."""
    return (at_ms + time_offset_ms) // _MINUTE_MS * _MINUTE_MS


def _sha512_b64(material: str) -> str:
    """UTF-8 문자열의 SHA-512 다이제스트를 표준 base64로. 뷰어의 E1MjE0ODA0(_, r=1) 재현."""
    return base64.b64encode(hashlib.sha512(material.encode("utf-8")).digest()).decode("ascii")


def _xor_b64(n_b64: str, r_b64: str) -> str:
    """두 base64 값을 디코드해 **뒤에서부터** 정렬해 XOR 하고 다시 base64로. 뷰어의 xorB64 재현.

    짧은 쪽이 긴 쪽의 뒤쪽 바이트에만 걸린다. 길이 판단은 원본과 동일하게 base64 문자열
    길이로 하되(디코드 전), 실제 XOR는 바이트 배열에서 끝을 맞춰 수행한다.
    """
    long_b64, short_b64 = (n_b64, r_b64)
    if len(short_b64) > len(long_b64):
        long_b64, short_b64 = short_b64, long_b64
    out = bytearray(base64.b64decode(long_b64))
    short = base64.b64decode(short_b64)
    for i in range(1, len(short) + 1):
        out[-i] ^= short[-i]
    return base64.b64encode(bytes(out)).decode("ascii")


def download_token(doc_id: str, *, at_ms: int | None = None, time_offset_ms: int = 0) -> str:
    """다운로드 서명 토큰(noBypass:true 경로)을 계산한다.

    at_ms가 None이면 현재 시각을 쓴다. 결정적 재현이 필요하면 at_ms를 고정 주입한다.
    time_offset_ms는 서버-클라이언트 시각차(뷰어의 timeOffset).
    """
    now_ms = int(time.time() * 1000) if at_ms is None else at_ms
    minute_ms = _minute_floor_ms(now_ms, time_offset_ms)
    raw_hash_b64 = _sha512_b64(str(minute_ms) + doc_id)  # kzNTE3Njgz: 분문자열 + docId 순서
    return _xor_b64(raw_hash_b64, _XOR_KEY_B64)  # A0OTMwODA1: 하드코딩 키로 한 겹 XOR


def param_name() -> str:
    """다운로드 파라미터 이름(난수). 뷰어는 btoa(6자리 16진수)로 만든다 — 재현 대상이 아니라 형식만 맞춘다."""
    return base64.b64encode(secrets.token_hex(3).encode("ascii")).decode("ascii")


def download_url(
    base: str,
    doc_id: str,
    *,
    original_id: str | None = None,
    file_name: str | None = None,
    insert_tsa: bool = False,
    at_ms: int | None = None,
    time_offset_ms: int = 0,
    param: str | None = None,
) -> str:
    """다운로드 URL을 조립한다. 뷰어의 getDownloadUrl 재현(다운로드는 noBypass:true 고정).

    param을 주면 난수 파라미터 이름 대신 사용한다(테스트 결정성용). base는 baseHref로,
    끝 슬래시 유무를 그대로 존중한다.
    """
    from urllib.parse import quote

    token = download_token(doc_id, at_ms=at_ms, time_offset_ms=time_offset_ms)
    key = param if param is not None else param_name()
    path = f"{base}v4/documents/{quote(doc_id, safe='')}"
    if insert_tsa:
        path += "/tsa"
    # 토큰 base64의 +,/,= 는 쿼리에서 값으로 그대로 실려야 하므로 quote의 safe에 포함한다.
    query = [f"{key}={quote(token, safe='+/=')}"]
    if original_id is not None:
        query.append(f"originalId={quote(original_id, safe='')}")
    if file_name is not None:
        query.append(f"fileName={quote(file_name, safe='')}")
    return f"{path}?{'&'.join(query)}"
