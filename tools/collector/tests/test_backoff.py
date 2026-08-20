# 백오프 계산 단위 테스트 — 정상/실패/경계값 (AGENTS.md 규칙 11)
import pytest

from collector.backoff import backoff_delay_ms, interval_delay_ms, jittered_ms


def test_정상_지수_증가():
    assert backoff_delay_ms(1) == 1500
    assert backoff_delay_ms(2) == 3000
    assert backoff_delay_ms(3) == 6000


def test_경계_상한_캡():
    assert backoff_delay_ms(10) == 60000
    assert backoff_delay_ms(6, base_ms=1500, max_ms=48000) == 48000


def test_실패_잘못된_입력():
    with pytest.raises(ValueError):
        backoff_delay_ms(0)
    with pytest.raises(ValueError):
        backoff_delay_ms(1, base_ms=-1)


def test_간격_지터는_설정값보다_빨라지지_않는다():
    """흔들림은 위로만 준다 — 간격은 수집 예절의 하한이라 더 빨라지면 안 된다 (D-007)."""
    assert interval_delay_ms(1500, rand=lambda: 0.0) == 1500  # 최소
    assert interval_delay_ms(1500, rand=lambda: 1.0) == 2400  # 최대 1.6배
    assert interval_delay_ms(1500, rand=lambda: 0.5) == 1950


def test_간격_지터는_고정값을_흩는다():
    """같은 설정에서 서로 다른 값이 나와야 한다 — 고정 간격 자체가 기계 지문이다."""
    import random

    delays = {interval_delay_ms(1500, rand=random.random) for _ in range(50)}

    assert len(delays) > 10
    assert all(1500 <= delay <= 2400 for delay in delays)


def test_백오프_지터는_절반을_남긴다():
    """물러서기의 의도를 지키면서 재시도가 같은 순간에 겹치지 않게 흩는다."""
    assert jittered_ms(6000, rand=lambda: 0.0) == 3000
    assert jittered_ms(6000, rand=lambda: 1.0) == 6000


def test_지터_실패_잘못된_입력():
    with pytest.raises(ValueError):
        interval_delay_ms(-1, rand=lambda: 0.0)
    with pytest.raises(ValueError):
        jittered_ms(-1, rand=lambda: 0.0)
