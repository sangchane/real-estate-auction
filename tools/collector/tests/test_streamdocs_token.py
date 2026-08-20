# StreamDocs 다운로드 토큰 재현 단위 테스트 — 실측 대조/경계값 (AGENTS.md 규칙 11)
import base64

from collector.streamdocs_token import (
    _minute_floor_ms,
    _xor_b64,
    download_token,
    download_url,
    param_name,
)

# 브라우저에서 실제로 나간 다운로드 URL에서 뽑은 실측값.
_DOC_ID = "P0jxZEDgWK_MYVyA1Fd73QuKhQW51O4WFJr5NjSsL1I"
_OBSERVED_TOKEN = "x2HMyOXUvyb82ijb7jcF0v1VQA5K6NLC1xKcpMqa+n7uZkBrLHDBQIpxvmTVAXNhCFELcwVlPVRLTun/pziRRg=="
# 스캔으로 찾은 분: 2026-08-20 14:28:00 KST = 1787203680000 ms.
_MATCH_MINUTE_MS = 1787203680000


def test_실측_토큰_재현():
    # 시간을 고정 주입(at_ms)해 결정적으로 관측 토큰과 일치하는지 단언한다.
    assert download_token(_DOC_ID, at_ms=_MATCH_MINUTE_MS) == _OBSERVED_TOKEN


def test_경계_분단위_내림():
    # 같은 분 안(초·밀리초)이면 내림 결과가 같아 토큰도 같다.
    assert download_token(_DOC_ID, at_ms=_MATCH_MINUTE_MS + 59_999) == _OBSERVED_TOKEN
    # 다음 분으로 넘어가면 토큰이 달라진다.
    assert download_token(_DOC_ID, at_ms=_MATCH_MINUTE_MS + 60_000) != _OBSERVED_TOKEN


def test_경계_시각차_오프셋():
    # time_offset_ms로 한 분 앞당기면, 그만큼 이른 시각을 at_ms로 준 것과 동일하다.
    with_offset = download_token(_DOC_ID, at_ms=_MATCH_MINUTE_MS, time_offset_ms=-60_000)
    with_earlier = download_token(_DOC_ID, at_ms=_MATCH_MINUTE_MS - 60_000)
    assert with_offset == with_earlier
    assert with_offset != _OBSERVED_TOKEN


def test_minute_floor_격자_정렬():
    assert _minute_floor_ms(_MATCH_MINUTE_MS + 1, 0) == _MATCH_MINUTE_MS
    assert _minute_floor_ms(_MATCH_MINUTE_MS, 0) == _MATCH_MINUTE_MS
    assert _minute_floor_ms(_MATCH_MINUTE_MS - 1, 0) == _MATCH_MINUTE_MS - 60_000


def test_param_name_형식():
    name = param_name()
    # btoa(6자리 16진수) → base64 8자, 디코드하면 소문자 16진수 6자.
    assert len(name) == 8
    decoded = base64.b64decode(name).decode("ascii")
    assert len(decoded) == 6
    assert all(c in "0123456789abcdef" for c in decoded)


def test_xor_뒤에서_정렬_짧은쪽():
    # 긴쪽 4바이트, 짧은쪽 1바이트 → 마지막 바이트만 XOR 된다.
    long_b64 = base64.b64encode(bytes([1, 2, 3, 4])).decode()
    short_b64 = base64.b64encode(bytes([0xFF])).decode()
    result = base64.b64decode(_xor_b64(long_b64, short_b64))
    assert list(result) == [1, 2, 3, 4 ^ 0xFF]


def test_xor_인자순서_무관_긴쪽이_두번째():
    # 짧은 쪽을 먼저 줘도 긴 쪽을 base로 잡아 결과가 같다(원본의 swap).
    long_b64 = base64.b64encode(bytes([1, 2, 3, 4])).decode()
    short_b64 = base64.b64encode(bytes([0xFF])).decode()
    assert _xor_b64(short_b64, long_b64) == _xor_b64(long_b64, short_b64)


def test_xor_같은길이_전체_xor():
    # 64바이트 동일 길이면 전체가 XOR 된다: 토큰을 키로 다시 XOR 하면 원래 다이제스트 복원.
    key = base64.b64decode(
        "AZsCErpKMi90AHruj94DUc7vjafUVyowwStODTNPMDdEYV0rZVQ8xsuHLlmGwEx0HM6M8IkSKt9yCSzj+5W0ZA=="
    )
    token_bytes = base64.b64decode(_OBSERVED_TOKEN)
    restored = base64.b64decode(
        _xor_b64(_OBSERVED_TOKEN, base64.b64encode(key).decode())
    )
    assert restored == bytes(a ^ b for a, b in zip(token_bytes, key))


def test_download_url_조립():
    url = download_url(
        "https://viewer.example/",
        _DOC_ID,
        original_id="orig-1",
        file_name="감정평가서.pdf",
        at_ms=_MATCH_MINUTE_MS,
        param="Y2NkN2E5",
    )
    # 경로에 docId, 쿼리에 고정 파라미터명=토큰, originalId, fileName(퍼센트 인코딩)이 들어간다.
    assert url.startswith(f"https://viewer.example/v4/documents/{_DOC_ID}?")
    assert f"Y2NkN2E5={_OBSERVED_TOKEN}" in url
    assert "originalId=orig-1" in url
    assert "fileName=%EA%B0%90%EC%A0%95%ED%8F%89%EA%B0%80%EC%84%9C.pdf" in url


def test_download_url_tsa_경로():
    url = download_url(
        "https://viewer.example/",
        _DOC_ID,
        insert_tsa=True,
        at_ms=_MATCH_MINUTE_MS,
        param="Y2NkN2E5",
    )
    assert f"/v4/documents/{_DOC_ID}/tsa?" in url
