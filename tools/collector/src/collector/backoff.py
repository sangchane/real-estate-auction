# 지수 백오프 대기시간 계산 — 수집기 재시도 정책의 순수 함수 (AGENTS.md 규칙 4, D-007 수집 예절)
from __future__ import annotations

from collections.abc import Callable


def backoff_delay_ms(attempt: int, base_ms: int = 1500, max_ms: int = 60000) -> int:
    """재시도 회차(attempt, 1부터)에 대한 대기시간(ms)을 반환한다. 상한 max_ms로 캡."""
    if attempt < 1:
        raise ValueError("attempt는 1 이상이어야 합니다")
    if base_ms < 0 or max_ms < 0:
        raise ValueError("base_ms/max_ms는 음수일 수 없습니다")
    return min(base_ms * (2 ** (attempt - 1)), max_ms)


def interval_delay_ms(interval_ms: int, *, rand: Callable[[], float]) -> int:
    """요청 사이 간격에 흔들림을 준다 — 설정값 이상, 최대 1.6배.

    고정 간격은 그 자체가 기계 지문이다. 수백 요청이 오차 없이 같은 간격으로 오면 사람이
    아니라는 것이 자명해서 속도제한·차단 규칙에 걸리기 쉽다 (실측 2026-08-20: 하루에
    ipcheck 빈 응답으로 degrade).

    **설정값보다 빨라지지는 않는다.** 간격은 예절의 하한이라 흔들림은 위로만 준다.
    """
    if interval_ms < 0:
        raise ValueError("interval_ms는 음수일 수 없습니다")
    return round(interval_ms * (1.0 + 0.6 * rand()))


def jittered_ms(delay_ms: int, *, rand: Callable[[], float]) -> int:
    """계산된 대기시간의 50~100% 사이 임의 값 (half jitter).

    재시도가 결정적이면 같이 실패한 요청들이 정확히 같은 순간에 되돌아와 부하가 겹친다.
    절반은 남겨 지수 증가의 의도(물러서기)를 지키고 나머지만 흩는다.
    """
    if delay_ms < 0:
        raise ValueError("delay_ms는 음수일 수 없습니다")
    return round(delay_ms * (0.5 + 0.5 * rand()))
