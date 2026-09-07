# 매각물건명세서 PDF 텍스트 레이어(streamdocs texts)에서 점유자(임차인) 표를 좌표로 복원한다
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any


# 점유자 표 컬럼의 x 경계 (실측 — 대법원 매각물건명세서 표준 양식, 좌표 단위는 PDF 포인트).
# 셀 값이 컬럼 폭보다 길면 같은 셀 안에서 여러 줄로 나뉘므로 x로 컬럼을, y로 행을 정한다.
_COLUMNS: tuple[tuple[str, int, int], ...] = (
    ("tenant_name", 30, 73),
    ("occupied_part", 73, 110),
    ("source_kind", 110, 160),
    ("possession_basis", 160, 198),
    ("lease_period", 198, 268),
    ("deposit_amount", 268, 325),
    ("monthly_rent", 325, 381),
    ("move_in_date", 381, 447),
    ("fixed_date", 447, 506),
    ("demanded_distribution", 506, 570),
)

# 표준 양식에서 머리글 "정보출처" 첫 글자의 x1 (실측 — 보유 픽스처 5종 모두 114.0).
# 일부 문서는 같은 표가 통째로 좌우로 밀려 렌더된다 (실측 2026-08-06 서울중앙 2025타경102642:
# -9pt). 고정 경계로는 각 컬럼의 첫 글자가 이전 컬럼으로 새어 정보출처가 "리신고임"처럼
# 깨지고, 검증 게이트가 전 행을 버린다 — 임차인이 있는 문서가 통째로 사라지는 경로였다.
# 머리글 실측 x1과 이 기준의 차를 컬럼 경계에 더해 문서별로 보정한다.
_HEADER_SOURCE_LABEL = "정보출처"
_HEADER_SOURCE_X1 = 114.0
# 보정 한도 — 이보다 크게 어긋나면 아는 양식이 아니다. 엉뚱한 문서에 경계를 끌려가느니
# 보정 없이 파싱해 게이트가 버리게 두는 쪽이 안전하다.
_MAX_COLUMN_OFFSET = 30.0

# 값이 줄바꿈 없이 한 줄로만 적히는 컬럼들 — 행의 기준선(anchor)을 잡는 데 쓴다.
# 점유부분은 앵커가 아니다 — "공부상 505호(실제표시 605호)"처럼 5줄로 감싸인 실측이 있다.
# 앵커로 쓰면 감싸인 줄마다 가짜 행이 생긴다 (WP-11 §4-7의 수율 붕괴 원인).
#
# 보증금·차임·확정일자도 같은 이유로 뺐다. "한 줄"이라던 전제가 틀렸다 — 보증금 증액 사건은
# 한 셀에 `1)190,000,000` / `2)200,000,000`을, 등기 임차권은 `200,000,000` / `(2023.2.2.` /
# `10,000,000` / `증액)`을 여러 줄로 적는다(실측 B000210 2025타경908). 확정일자도 증액분마다
# `1)`,`2)`로 나뉜다. 이들을 앵커로 쓰면 한 임차인이 3~4행으로 쪼개지고, 쪼개진 조각은
# 정보출처가 없어 검증 게이트에서 버려진다 — 보증금이 통째로 사라지는 경로였다.
#
# 전입신고일자와 배당요구여부를 앵커로 쓴다. 주거 사건은 값이 날짜 하나라 행마다 한 줄이지만,
# 상가 사건은 "2023.10.31.(상가건물임대차현황서)"가 3줄로 감싸인다 (실측 2025타경9542) —
# 그래서 앵커는 "날짜가 있는 줄"이 행을 시작하고, 날짜 없는 감싸임 조각은 직전 행에 붙는
# 클러스터로 잡는다 (_anchors_from). 셀 안 줄바꿈 간격 실측 12.5~13pt, 행 사이 앵커 간격은
# 32pt 이상인데 **인접 행의 조각과 다음 행 날짜 사이가 11pt**인 문서가 있어 간격만으로는
# 못 가른다 — 날짜 유무가 행 경계의 근거다.
_ANCHOR_FIELDS = (
    "move_in_date",
    "demanded_distribution",
)

# 전세권자처럼 전입신고일자·배당요구여부가 아예 없는 행만 있는 문서를 위한 대비책
# (실측 2022타경2593 물건1 — 등기 전세권 1행). 이때만 금액·확정일자로 행을 잡는다.
# 두 종류가 섞인 문서에서는 전입일이 있는 행만 잡히므로 완전하지 않다.
_FALLBACK_ANCHOR_FIELDS = ("deposit_amount", "monthly_rent", "fixed_date")

# 표 머리글 식별 — "점유자"와 "정보출처"가 같은 줄에 오는 것이 이 표의 특징이다
_HEADER_KEYWORDS = (
    "정보출처",
    "점유의",
    "임대차기간",
    "보 증 금",
    "확정일자",
    "요구여부",
    "성  명",
    "(점유기간)",
    "(배당요구일자)",
    "신청일자",
    "류지변경신고)",
)

# 표 아래 경계 — 명세서 양식에서 표 다음에 반드시 오는 란
_TABLE_END_MARKERS = ("<비고>", "비고란", "※")

_DATE_PATTERN = re.compile(r"(?<!\d)(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})(?!\d)")
# Tenant dates before 1900 are not plausible here; observed values such as 0022
# and 0217 were malformed source/PDF parses and must remain unknown instead.
_MIN_PLAUSIBLE_DATE_YEAR = 1900
# 콤마가 있으면 천단위로 정확히 끊겨 있어야 금액 하나로 읽는다. 셀 안에서 줄바꿈된 금액 두 개는
# 구분자 없이 이어붙는데(실측 2025타경51589 `220,000,000231,000,000`), 예전 `^[0-9][0-9,]*$`는
# 이것을 18자리 수 하나로 읽어 220조를 저장했다. 콤마 위치가 어긋나면 아래 다중 금액 경로로 보낸다.
_DIGIT_AMOUNT_PATTERN = re.compile(r"^(?:\d+|\d{1,3}(?:,\d{3})+)$")
# 금액 상한. 넘으면 셀이 어긋나 여러 금액이 이어붙은 것으로 보고 값을 버린다 — 실측 최대 보증금은
# 20억(2025타경597)이라 1조는 현실값과 겹치지 않는다. 콤마가 아예 없이 붙는 경우(`4000000040000000`)는
# 위 패턴으로 못 걸러 여기서 막는다. 막지 않으면 bigint를 넘겨 **명세서 한 건이 통째로 저장 실패**한다
# (실측 2026-08-18 2025타경12316: 24자리, 그 물건 명세서 전부 소실). 기일이 지나면 다시 못 받는다.
_MAX_PLAUSIBLE_AMOUNT = 1_000_000_000_000
# 한 셀에 금액이 여러 개 적힌 증액 사건에서 금액만 골라낸다. 천단위 콤마를 요구해야
# `1)200,000,0002)210,000,000`처럼 줄이 붙어버린 문자열에서도 경계가 흐트러지지 않는다.
_AMOUNT_IN_TEXT_PATTERN = re.compile(r"\d{1,3}(?:,\d{3})+")
# `1)…2)…` 형태의 순번 표기 — 뒤 번호가 현재(증액 후) 보증금이다.
_NUMBERED_AMOUNT_PATTERN = re.compile(r"\d\)\s*\d")
# 구사건은 보증금을 "천만원"·"1억5천만원" 같은 한글로 적는다 (실측).
# 억·만은 앞의 값을 묶는 큰 단위, 천·백·십은 그 안에서 더해지는 작은 단위다
_KOREAN_BIG_UNITS = {"억": 100_000_000, "만": 10_000}
_KOREAN_SMALL_UNITS = {"천": 1_000, "백": 100, "십": 10}
_UNKNOWN_VALUES = ("미상", "불명", "없음", "-")

# 같은 행의 앵커 후보(한 줄 컬럼 값들의 세로 중앙)를 하나로 묶는 허용 오차.
# 실측 줄높이 ~10pt, 인접 행의 앵커 간격은 45pt 이상이라 8이면 안전하다
_ANCHOR_MERGE_TOLERANCE = 8

# 셀 안 줄바꿈으로 감싸인 조각을 같은 행으로 붙이는 최대 간격.
# 실측 12.5~13pt(상가 사건 전입신고일자 셀), 행 사이 앵커 간격은 32pt 이상이라 20이 가른다
_CELL_WRAP_GAP_MAX = 20.0

# 한 라인 안에서 글자 덩어리(run)를 끊는 x 벌어짐. 같은 셀의 글자 상자는 맞닿아 있고(간격 ~0),
# 셀 사이는 컬럼 여백만큼 벌어진다
_RUN_SPLIT_GAP = 4.0

# 법원이 점유자 없음을 명시할 때 표 안에 이 문구 한 줄만 렌더된다 (실측: "조사된 임차내역없음").
# 행이 아니라 빈 표이므로 파싱 대상에서 제외한다
_NO_TENANT_MARKER = "임차내역없음"


@dataclass(frozen=True)
class DepositTranche:
    """확정일자별 보증금 몫. 증액분이면 `amount`는 늘어난 **차액**이다(누적 총액이 아니다).

    증액 재계약을 하면 원래 보증금은 종전 확정일자 순위를 유지하고 증액분만 새 확정일자
    날짜에 순위가 생긴다. 한 쌍(금액, 확정일자)으로는 표현할 수 없어 몫으로 나눠 둔다.
    """

    amount: int
    fixed_date: date | None


@dataclass(frozen=True)
class NoticeTenant:
    """auction_item_notice_tenant 한 행 — 명세서 점유자 표의 셀 값.

    같은 임차인이 정보출처별로 여러 행에 나오므로 행을 합치지 않고 source_kind로 구분해
    각각 저장한다. tenant_seq는 이름으로 묶은 동일인 순번이다 (WP-11 §4-3).

    row_no는 문서상 행 순서(1부터)다. 저장소의 고유키라서 필요하다 — 한 사람이 같은 정보출처로
    두 행을 갖는 문서가 실제로 있어 (tenant_seq, source_kind)로는 행을 구분할 수 없다.
    """

    row_no: int
    tenant_seq: int
    tenant_name: str | None
    source_kind: str | None
    occupied_part: str | None
    possession_basis: str | None
    lease_period: str | None
    deposit_amount: int | None
    monthly_rent: int | None
    move_in_date: date | None
    fixed_date: date | None
    demanded_distribution: bool | None
    demanded_distribution_date: date | None
    # 증액 재계약이 확인될 때만 채운다. 여기서 안 뽑아두면 기일이 지난 뒤에는 원본을
    # 다시 못 받아 영영 복구할 수 없다 (WP-11 §4-3과 같은 이유).
    deposit_tranches: tuple[DepositTranche, ...] | None = None
    # 배당요구여부 칸의 원문. bool 하나로는 "칸이 비었다"·"그 출처에는 이 칸이 없다"·"컬럼이
    # 어긋나 조각이 버려졌다"가 모두 NULL로 합류해 사후에 구분할 수 없다 — 그래서 전사해 둔다.
    # 이것도 기일이 지나면 다시 못 받는다 (deposit_tranches와 같은 이유, WP-11 §4-26).
    demanded_distribution_raw: str | None = None


@dataclass(frozen=True)
class TenantTable:
    """파싱 결과. `continued`는 표가 다음 페이지로 이어질 수 있음을 뜻한다.

    `rejected`는 검증 게이트에서 버린 행 수다. 좌표 기반 표 복원이 양식에 따라 셀 조각을
    별개 행으로 쪼개는 경우가 있어(실측: 10개 문서에서 20행 중 15행이 조각), 최소 요건을
    못 갖춘 행은 저장하지 않고 세기만 한다 — 쓰레기를 DB에 넣는 것보다 낫다 (WP-11 §4-6).
    """

    tenants: tuple[NoticeTenant, ...]
    continued: bool
    rejected: int = 0
    # 점유자 표 영역의 원본 라인(쪽별). 파서를 고친 뒤 재수집 없이 다시 파싱하려고 남긴다
    # (017, WP-11 §4-27·§4-29). 페이지 전체가 아니라 표 영역만 담는다 — 자유서술 3란의
    # 제3자 실명을 저장하지 않기로 한 결정(A-08, court_parser.ItemNotice)을 지킨다
    region_lines: tuple[tuple[Any, ...], ...] = ()


# 정보출처 정상값 — 이 셋 중 하나가 아니면 행 경계 자체가 잘못 잡힌 것으로 본다
_VALID_SOURCE_KINDS = ("현황조사", "권리신고", "등기사항전부증명서")


def _is_usable(tenant: NoticeTenant) -> bool:
    """저장할 가치가 있는 행인지 판정한다.

    정보출처가 정상값으로 시작해야 하고(행 경계가 제대로 잡혔다는 신호), 그 위에 권리분석에 쓸
    값이 하나라도 있어야 한다. 전입일은 엔진 `Tenant`의 필수 입력이고, 보증금은 인수액 계산의
    기초다. 완전일치가 아니라 시작 일치인 이유: "현황조사 등"처럼 꼬리를 붙여 적는 법원이
    실재한다 (실측 2023타경5380 — 보증금 2억 행이 이 표기 때문에 통째로 버려졌다).
    """
    if tenant.source_kind is None or not any(
        tenant.source_kind.startswith(kind) for kind in _VALID_SOURCE_KINDS
    ):
        return False
    return tenant.move_in_date is not None or tenant.deposit_amount is not None


def parse_tenant_table(pages: list[list[Any]]) -> TenantTable:
    """streamdocs texts 응답(페이지별 라인 목록)에서 점유자 표를 복원한다.

    표 머리글을 못 찾으면 빈 결과를 돌려준다 — 양식이 다른 문서에서 엉뚱한 값을 만들지 않는다.
    """
    rows: list[dict[str, str]] = []
    regions: list[tuple[Any, ...]] = []
    continued = False

    for lines in pages:
        fragments = _fragments(lines)
        bounds = _table_bounds(fragments)
        if bounds is None:
            continue
        top, bottom, has_end_marker, header_top = bounds
        offset = _column_offset(fragments)
        rows.extend(_rows_in_region(fragments, top=top, bottom=bottom, offset=offset))
        regions.append(_lines_in_span(lines, top=header_top, bottom=bottom))
        continued = not has_end_marker

    parsed = _to_tenants(rows)
    usable = tuple(tenant for tenant in parsed if _is_usable(tenant))
    return TenantTable(
        tenants=usable,
        continued=continued,
        rejected=len(parsed) - len(usable),
        region_lines=tuple(regions),
    )


def _lines_in_span(lines: list[Any], *, top: float, bottom: float) -> tuple[Any, ...]:
    """원본 라인 중 세로 중앙이 [bottom, top] 안에 드는 것만 고른다 (017 보관용).

    조각이 아니라 **원본 라인 객체를 그대로** 남긴다 — 그래야 저장한 값을 parse_tenant_table에
    다시 넣어 같은 경로로 재파싱할 수 있다. 머리글부터 담으므로 재파싱 때도 표를 찾는다.
    """
    kept: list[Any] = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        rects = line.get("rect")
        if not isinstance(rects, list):
            continue
        centers = [
            (_number(rect.get("bottom")) + _number(rect.get("top"))) / 2
            for rect in rects
            if isinstance(rect, dict)
        ]
        if centers and bottom <= sum(centers) / len(centers) <= top:
            kept.append(line)
    return tuple(kept)


def _fragments(lines: list[Any]) -> list[dict[str, Any]]:
    """라인 목록을 문자 단위 조각으로 펼친다 — 한 라인에 여러 셀이 섞여 있어 문자로 나눠야 한다.

    컬럼 판정용 x(column_x)는 글자 자신이 아니라 글자가 속한 덩어리(run)의 중앙이다.
    셀 값이 컬럼 상자보다 넓으면 첫 글자가 이웃 컬럼 영역에서 시작하는데(실측 2024타경136950:
    전입신고일자 "2022.11.09.(상…"의 앞자리가 차임 컬럼으로 샜다), 덩어리 중앙으로 정하면
    덩어리 전체가 제 컬럼에 붙는다.
    """
    fragments: list[dict[str, Any]] = []
    for line in lines:
        if not isinstance(line, dict):
            continue
        text = line.get("text")
        rects = line.get("rect")
        if not isinstance(text, str) or not isinstance(rects, list):
            continue
        last_index = len(text) - 1
        entries: list[dict[str, Any]] = []
        for index, (char, rect) in enumerate(zip(text, rects, strict=False)):
            if not isinstance(rect, dict):
                continue
            entries.append(
                {
                    "char": char,
                    "x1": _number(rect.get("left")),
                    "x2": _number(rect.get("right")),
                    "y1": _number(rect.get("bottom")),
                    "y2": _number(rect.get("top")),
                    # 원문 라인의 마지막 문자인지 — 셀 사이를 벌리는 공백과 셀 안의 공백을 가른다
                    "at_line_end": index == last_index,
                }
            )
        _assign_run_centers(entries)
        fragments.extend(entries)
    return fragments


def _assign_run_centers(entries: list[dict[str, Any]]) -> None:
    """한 라인의 조각을 공백·x 벌어짐으로 덩어리(run)로 묶고 각 조각에 덩어리 중앙을 기록한다."""
    runs: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for entry in entries:
        if entry["char"].isspace():
            if current:
                runs.append(current)
                current = []
            continue
        if current and entry["x1"] - current[-1]["x2"] > _RUN_SPLIT_GAP:
            runs.append(current)
            current = []
        current.append(entry)
    if current:
        runs.append(current)
    for run in runs:
        center = (run[0]["x1"] + run[-1]["x2"]) / 2
        for member in run:
            member["column_x"] = center


def _table_bounds(fragments: list[dict[str, Any]]) -> tuple[float, float, bool, float] | None:
    """표 영역의 위/아래 y 경계, 아래 경계가 종료 표시였는지, 머리글 맨 위 y를 돌려준다.

    머리글 맨 위는 원문 보관 범위를 정하는 데 쓴다(017) — 재파싱하려면 머리글이 있어야
    _table_bounds가 표를 다시 찾을 수 있다.
    """
    lines = _group_lines(fragments)
    header_index = next(
        (
            index
            for index, line in enumerate(lines)
            if "점유자" in line["text"] and "정보출처" in line["text"]
        ),
        None,
    )
    if header_index is None:
        return None

    # 머리글은 여러 줄로 감싸진다 — 아래로 내려가며 머리글 단어가 계속 나오는 동안 이어붙인다
    header_top = lines[header_index]["y2"]
    header_bottom = lines[header_index]["y1"]
    for line in lines[header_index + 1 :]:
        if not any(keyword in line["text"] for keyword in _HEADER_KEYWORDS):
            break
        header_bottom = line["y1"]

    for line in lines:
        if line["y2"] < header_bottom and any(
            line["text"].lstrip().startswith(marker) for marker in _TABLE_END_MARKERS
        ):
            return (header_bottom, line["y2"], True, header_top)
    return (header_bottom, 0.0, False, header_top)


def _group_lines(fragments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """문자 조각을 y 밴드로 묶어 라인으로 되돌린다 (y 내림차순)."""
    lines: list[list[dict[str, Any]]] = []
    for fragment in sorted(fragments, key=lambda f: (-f["y2"], f["x1"])):
        for line in lines:
            if abs(line[0]["y2"] - fragment["y2"]) <= 3:
                line.append(fragment)
                break
        else:
            lines.append([fragment])
    return [
        {
            "y1": min(f["y1"] for f in line),
            "y2": line[0]["y2"],
            "text": "".join(f["char"] for f in sorted(line, key=lambda f: f["x1"])),
        }
        for line in lines
    ]


def _column_offset(fragments: list[dict[str, Any]]) -> float:
    """머리글 "정보출처" 실측 x1과 표준 위치의 차 — 표가 좌우로 밀린 문서의 컬럼 보정값."""
    lines = _group_lines(fragments)
    header = next(
        (line for line in lines if "점유자" in line["text"] and "정보출처" in line["text"]),
        None,
    )
    if header is None:
        return 0.0
    band = sorted(
        (f for f in fragments if abs(f["y2"] - header["y2"]) <= 3), key=lambda f: f["x1"]
    )
    index = "".join(f["char"] for f in band).find(_HEADER_SOURCE_LABEL)
    if index < 0:
        return 0.0
    offset = band[index]["x1"] - _HEADER_SOURCE_X1
    return offset if abs(offset) <= _MAX_COLUMN_OFFSET else 0.0


def _rows_in_region(
    fragments: list[dict[str, Any]], *, top: float, bottom: float, offset: float = 0.0
) -> list[dict[str, str]]:
    """표 영역의 조각을 행으로 묶고 컬럼별 문자열 셀을 만든다.

    셀은 행 상자 안에서 세로 중앙정렬로 렌더된다 (실측). 앵커(한 줄 컬럼 값)가 행의 세로
    중앙이므로, 행의 위 경계가 b이면 아래 경계는 2*앵커 - b다. 이 경계로 조각을 나누면
    여러 줄로 감싸인 셀(점유부분·성명 등)이 인접 행으로 새거나 행을 쪼개지 않는다.
    """
    region = [f for f in fragments if bottom < f["y2"] < top]
    if not region:
        return []

    anchors = _row_anchors(region, offset)
    if not anchors:
        return []

    buckets: list[list[dict[str, Any]]] = [[] for _ in anchors]
    upper = top
    for index, anchor in enumerate(anchors):
        lower = 2 * anchor - upper
        following = anchors[index + 1] if index + 1 < len(anchors) else None
        if following is not None and lower <= following:
            # 중앙정렬 전제가 깨진 문서 — 다음 앵커를 침범하지 않게 두 앵커의 중점으로 물러선다
            lower = (anchor + following) / 2
        for fragment in region:
            if lower < (fragment["y1"] + fragment["y2"]) / 2 <= upper:
                buckets[index].append(fragment)
        upper = lower

    rows = [cells for cells in (_cells(bucket, offset) for bucket in buckets) if cells]
    return [
        row
        for row in rows
        if _NO_TENANT_MARKER not in "".join(row.values()).replace(" ", "")
    ]


def _row_anchors(region: list[dict[str, Any]], offset: float = 0.0) -> list[float]:
    """행의 세로 중앙 y 목록. 앵커 컬럼 값의 세로 중앙이 행의 중앙과 일치한다."""
    anchors = _anchors_from(region, _ANCHOR_FIELDS, offset, date_starts_row=True)
    if anchors:
        return anchors
    # 대비책 컬럼은 금액이 여러 줄로 적히는 사건(908 증액)이 있어 날짜 규칙을 쓰지 않는다
    return _anchors_from(region, _FALLBACK_ANCHOR_FIELDS, offset, date_starts_row=False)


def _anchors_from(
    region: list[dict[str, Any]],
    fields: tuple[str, ...],
    offset: float = 0.0,
    *,
    date_starts_row: bool,
) -> list[float]:
    """컬럼별로 줄을 행 묶음(cluster)으로 나누고 묶음의 세로 중앙을 앵커로 쓴다.

    상가 사건은 앵커 컬럼(전입신고일자)이 "2023.10.31.(상가건물임대차현황서)" 3줄로 감싸이고,
    감싸임 조각과 **다음 행의 날짜 줄 사이(11pt)가 셀 안 줄 간격(12.5~13pt)보다 좁은** 문서가
    실재한다 (2025타경9542) — 간격만으로는 행을 못 가르므로 날짜가 있는 줄만 행을 시작하게
    한다. 날짜 없는 줄은 "미상"처럼 그 자체가 값인 경우가 있어, 간격이 행 간격(32pt+)이면
    새 행으로 연다.
    """
    anchors: list[float] = []
    for field in fields:
        lines: dict[float, list[tuple[float, str]]] = {}
        for fragment in region:
            if _column_of(fragment, offset) == field and not fragment["char"].isspace():
                center = round((fragment["y1"] + fragment["y2"]) / 2, 1)
                lines.setdefault(center, []).append((fragment["x1"], fragment["char"]))
        clusters: list[list[float]] = []
        for y in sorted(lines, reverse=True):
            text = "".join(char for _, char in sorted(lines[y]))
            has_date = _DATE_PATTERN.search(text) is not None
            starts_row = (
                not clusters
                or clusters[-1][-1] - y > _CELL_WRAP_GAP_MAX
                or (date_starts_row and has_date)
            )
            if starts_row:
                clusters.append([y])
            else:
                clusters[-1].append(y)
        anchors.extend((cluster[0] + cluster[-1]) / 2 for cluster in clusters)

    # 컬럼별 앵커를 합치고, 같은 행의 두 컬럼이 낸 가까운 앵커는 하나로 본다
    merged: list[float] = []
    for y in sorted(anchors, reverse=True):
        if not merged or merged[-1] - y > _ANCHOR_MERGE_TOLERANCE:
            merged.append(y)
    return merged


def _cells(fragments: list[dict[str, Any]], offset: float = 0.0) -> dict[str, str]:
    """한 행의 조각을 컬럼별 문자열로 만든다.

    셀 안에서 줄바꿈된 값은 위에서 아래 순으로 이어붙인다. 이때 원문 라인 끝의 공백만 살린다 —
    한 라인에 여러 셀이 함께 렌더링되므로, 라인 중간의 공백은 셀 사이를 벌리는 간격이라
    이어붙일 때 붙여 쓰면 "주거 주택임차권자"가 "주거 주택임 차권자"로 어긋난다.
    """
    by_column: dict[str, list[dict[str, Any]]] = {}
    for fragment in fragments:
        if fragment["char"].isspace() and not fragment["at_line_end"]:
            continue
        column = _column_of(fragment, offset)
        if column is not None:
            by_column.setdefault(column, []).append(fragment)

    cells: dict[str, str] = {}
    for column, items in by_column.items():
        items.sort(key=lambda f: (-f["y2"], f["x1"]))
        text = " ".join("".join(f["char"] for f in items).split())
        if text:
            cells[column] = text
    return cells


def _column_of(fragment: dict[str, Any], offset: float = 0.0) -> str | None:
    # column_x가 없는 조각은 공백(run에 안 묶임) — 자기 중앙으로 판정한다
    center = fragment.get("column_x", (fragment["x1"] + fragment["x2"]) / 2) - offset
    for name, left, right in _COLUMNS:
        if left <= center < right:
            return name
    return None


def _to_tenants(rows: list[dict[str, str]]) -> tuple[NoticeTenant, ...]:
    """셀 문자열 행을 저장용 값으로 바꾸고 동일인 순번(tenant_seq)을 부여한다.

    한 점유자가 정보출처별로 여러 행에 걸칠 때(rowspan) 성명은 **병합 셀에 한 번만** 렌더된다.
    따라서 성명이 없는 행은 직전 점유자의 연속으로 보고 같은 순번을 잇는다 —
    행 순번을 그대로 쓰면 한 사람이 여럿으로 세어져 H3(임차인 수)이 어긋난다 (WP-11 §4-8).
    """
    seq_by_name: dict[str, int] = {}
    tenants: list[NoticeTenant] = []
    previous_seq: int | None = None

    # row_no는 검증 게이트 이전의 문서상 순서다 — 버려진 행 자리에 번호가 비지만 고유하면 된다
    for row_no, row in enumerate(rows, start=1):
        name = row.get("tenant_name")
        if name is None:
            # 첫 행부터 성명이 없으면 이을 앞 행이 없으므로 새 순번을 연다
            seq = previous_seq if previous_seq is not None else len(seq_by_name) + 1
        else:
            seq = seq_by_name.setdefault(name, len(seq_by_name) + 1)
        previous_seq = seq

        demanded_text = row.get("demanded_distribution")
        demanded_date = _parse_date(demanded_text)
        tenants.append(
            NoticeTenant(
                row_no=row_no,
                tenant_seq=seq,
                tenant_name=name,
                source_kind=row.get("source_kind"),
                occupied_part=row.get("occupied_part"),
                possession_basis=row.get("possession_basis"),
                lease_period=row.get("lease_period"),
                deposit_amount=_parse_amount(row.get("deposit_amount")),
                monthly_rent=_parse_amount(row.get("monthly_rent")),
                move_in_date=_parse_date(row.get("move_in_date")),
                fixed_date=_parse_date(row.get("fixed_date")),
                demanded_distribution=_parse_demanded(demanded_text, demanded_date),
                demanded_distribution_date=demanded_date,
                # 가공하지 않은 셀 원문 — 판정을 바꾸지 않고 근거만 남긴다
                demanded_distribution_raw=demanded_text,
                deposit_tranches=_parse_deposit_tranches(
                    row.get("deposit_amount"), row.get("fixed_date")
                ),
            )
        )
    return tuple(tenants)


def _parse_date(text: str | None) -> date | None:
    """"2021.06.04" 형태를 날짜로 바꾼다. "미상" 등은 None (실측 — 확정일자에 자주 나온다)."""
    if text is None or any(unknown in text for unknown in _UNKNOWN_VALUES):
        return None
    match = _DATE_PATTERN.search(text)
    if match is None:
        return None
    if int(match.group(1)) < _MIN_PLAUSIBLE_DATE_YEAR:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def _parse_amount(text: str | None) -> int | None:
    """금액 셀을 정수로 바꾼다. 숫자 표기와 한글 표기(구사건)를 모두 받고, 모르면 None.

    보증금 증액 사건은 한 셀에 금액을 여러 개 적는다 (실측 B000210 2025타경908):

    - `1)200,000,000 2)210,000,000` — 순번이 붙으면 **뒤 번호가 증액 후 현재 보증금**이다.
    - `210,000,000(2022.6.1. 10,000,000 증액)` — 괄호 앞이 현재 보증금이고
      괄호 안은 증액된 금액과 시점이다. 괄호 안 금액을 집으면 2.1억을 1천만으로 읽는다.

    권리분석에 필요한 값은 어느 쪽이든 **현재 보증금**이라 그것만 남긴다.

    셀이 어긋나 금액 여러 개가 한 셀로 이어붙은 문자열은 금액 하나로 읽지 않는다
    (`_DIGIT_AMOUNT_PATTERN`·`_MAX_PLAUSIBLE_AMOUNT`).
    """
    if text is None:
        return None
    cleaned = text.replace(" ", "").removesuffix("원")
    if not cleaned or any(unknown in cleaned for unknown in _UNKNOWN_VALUES):
        return None
    if _DIGIT_AMOUNT_PATTERN.match(cleaned):
        return _plausible_amount(int(cleaned.replace(",", "")))

    amounts = _AMOUNT_IN_TEXT_PATTERN.findall(cleaned)
    if amounts:
        chosen = amounts[-1] if _NUMBERED_AMOUNT_PATTERN.search(cleaned) else amounts[0]
        return _plausible_amount(int(chosen.replace(",", "")))

    return _parse_korean_amount(cleaned)


def _plausible_amount(value: int) -> int | None:
    """상한을 넘는 금액은 셀이 어긋나 이어붙은 결과다 — 지어내지 않고 버린다."""
    return value if value <= _MAX_PLAUSIBLE_AMOUNT else None


_NUMBERED_ENTRY_PATTERN = re.compile(r"(\d)\)\s*(\d{1,3}(?:,\d{3})+)")
_NUMBERED_DATE_PATTERN = re.compile(r"(\d)\)\s*(\d{4}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2})")


def _parse_deposit_tranches(
    deposit_text: str | None, fixed_text: str | None
) -> tuple[DepositTranche, ...] | None:
    """보증금 셀과 확정일자 셀에서 확정일자별 몫을 뽑는다. 확신이 없으면 None.

    명세서가 증액을 적는 방식이 둘이라 둘 다 받는다 (실측 서울동부 2025타경908 물건1):

    - 순번형: 보증금 `1)200,000,000 2)210,000,000`, 확정일자 `1)2020.06.12. 2)2022.06.03.`
      금액은 **누적 총액**이라 차액으로 바꿔야 몫이 된다 → [2억 @2020-06-12, 1천만 @2022-06-03]
    - 괄호형: 보증금 `210,000,000(2022.6.1. 10,000,000 증액)` + 위와 같은 확정일자 셀
      괄호 앞이 총액, 괄호 안이 증액분이라 총액에서 빼면 원금이 된다 → 같은 결과

    금액과 확정일자의 개수가 안 맞거나 누적이 증가하지 않으면 지어내지 않고 None을 준다.
    """
    if deposit_text is None or fixed_text is None:
        return None

    dates = [_parse_date(raw) for _, raw in _NUMBERED_DATE_PATTERN.findall(fixed_text)]
    if len(dates) < 2:
        return None

    cleaned = deposit_text.replace(" ", "")
    numbered = [entry for _, entry in _NUMBERED_ENTRY_PATTERN.findall(cleaned)]

    if len(numbered) >= 2:
        cumulative = [int(value.replace(",", "")) for value in numbered]
    elif "증액" in cleaned and len(dates) == 2:
        amounts = [int(v.replace(",", "")) for v in _AMOUNT_IN_TEXT_PATTERN.findall(cleaned)]
        if len(amounts) != 2:
            return None
        total, increase = amounts
        if increase <= 0 or increase >= total:
            return None
        cumulative = [total - increase, total]
    else:
        return None

    if len(cumulative) != len(dates):
        return None

    tranches: list[DepositTranche] = []
    previous = 0
    for total, fixed_date in zip(cumulative, dates, strict=True):
        amount = total - previous
        if amount <= 0:
            return None  # 누적이 줄면 우리가 아는 증액 형태가 아니다 — 추측하지 않는다
        tranches.append(DepositTranche(amount=amount, fixed_date=fixed_date))
        previous = total
    return tuple(tranches)


def _parse_korean_amount(text: str) -> int | None:
    """"천만", "1억5천만", "2억" 같은 한글 금액 표기를 정수로 바꾼다. 해석 못하면 None."""
    total = 0
    section = 0
    digits = ""
    for char in text.replace(",", ""):
        if char.isdigit():
            digits += char
            continue
        value = int(digits) if digits else 1
        digits = ""
        if char in _KOREAN_SMALL_UNITS:
            section += value * _KOREAN_SMALL_UNITS[char]
        elif char in _KOREAN_BIG_UNITS:
            total += (section + value if section == 0 else section) * _KOREAN_BIG_UNITS[char]
            section = 0
        else:
            return None  # 해석할 수 없는 글자가 섞이면 금액을 지어내지 않는다
    result = total + section + (int(digits) if digits else 0)
    return result or None


def _parse_demanded(text: str | None, parsed_date: date | None) -> bool | None:
    """배당요구여부 — 일자가 적혀 있으면 요구한 것이다. 공란·판독 불가는 None.

    False 는 법원이 그 칸에 "없음"류를 적었을 때만 만든다. 그 밖의 텍스트는 True 로 단정하지
    않는다 — 예전 규칙(`"없" not in text`)은 "미상"·"불명"·"-" 를 True 로 기록해 **배당요구를
    한 것으로 뒤집었다**(실측 3행: 날짜 없는 true). `_UNKNOWN_VALUES` 검사가 `_parse_date` 에만
    있고 여기에는 없었던 탓이다. 모르는 표기는 지어내지 않고 None 으로 둔다.

    None 을 "요구 안 함"으로 바꾸지 않는 이유는 WP-11 §4-26 에 있다 — 이 칸은 권리신고 행에만
    적히고(실측: true 2,617 중 2,599 가 권리신고 행, 현황조사·등기 행 4,075 은 전부 공란),
    공란을 False 로 새기면 배당요구가 확인된 그 사람의 다른 출처 행 1,613 건이 자기모순이 된다.
    """
    if parsed_date is not None:
        return True
    if text is None:
        return None
    if "없" in text:
        return False
    return None


def _number(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) else 0.0
