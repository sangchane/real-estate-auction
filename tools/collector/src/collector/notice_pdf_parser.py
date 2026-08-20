# 매각물건명세서 PDF의 표 구조(괘선)에서 점유자(임차인) 표를 읽는다.
from __future__ import annotations

from typing import Any

from collector.notice_tenant_parser import (
    NoticeTenant,
    TenantTable,
    _is_usable,
    _parse_amount,
    _parse_date,
    _parse_demanded,
    _parse_deposit_tranches,
)

# 머리글 문구 -> 컬럼 이름. 공백을 지운 뒤 부분일치로 찾는다 — 양식이 "보 증 금"처럼 자간을
# 벌려 적고, 셀 안에서 줄바꿈되면 조각 사이에 공백이 끼기 때문이다.
# 먼저 맞는 것을 쓰므로 순서가 중요하다: "전입신고일자…사업자등록신청일자"가 "신청일자"를
# 품고 있어 좁은 것부터 두면 엉뚱한 컬럼에 붙는다.
_HEADER_FIELDS: tuple[tuple[str, str], ...] = (
    ("점유자성명", "tenant_name"),
    ("성명", "tenant_name"),
    ("점유부분", "occupied_part"),
    ("정보출처", "source_kind"),
    ("점유의권원", "possession_basis"),
    ("임대차기간", "lease_period"),
    ("보증금", "deposit_amount"),
    ("차임", "monthly_rent"),
    ("전입신고일자", "move_in_date"),
    ("확정일자", "fixed_date"),
    ("배당요구여부", "demanded_distribution"),
)

# 임대차기간만 공백을 살린다 — "16.11.10 23.11.09"처럼 공백이 시작·종료의 구분자다.
# 나머지는 셀 안 줄바꿈이 공백으로 남아 값을 깨뜨리므로 전부 지운다
# (실측: 성명 "주식회 사 스타벅 스커피 코리아" -> "주식회사스타벅스커피코리아").
_KEEP_SPACES = ("lease_period",)


def parse_tenant_table_from_cells(document: dict[str, Any]) -> TenantTable:
    """opendataloader-pdf가 낸 문서 JSON에서 점유자 표를 복원한다.

    텍스트 레이어 파서(notice_tenant_parser)와 같은 결과 타입을 돌려준다 — 호출부가
    두 경로를 갈아끼울 수 있어야 한다 (WP-11 §4-31).

    좌표 파서와 결정적으로 다른 점은 **사람을 성명 문자열이 아니라 병합셀로 묶는다**는 것이다.
    한 임차인이 정보출처별로 여러 행을 가지면 성명은 rowspan 병합셀에 한 번만 렌더되는데,
    괘선이 있는 PDF에서는 그 셀이 어느 행들을 덮는지가 명시돼 있다. 텍스트 레이어에는 그
    경계가 없어 "한 이름이 두 줄로 감싸인 것"과 "짧은 이름 둘이 이웃한 것"을 못 갈랐다
    (WP-11 §4-29·§4-30).
    """
    table = _tenant_table(document)
    if table is None:
        return TenantTable(tenants=(), continued=False, rejected=0)

    header = _header_row(table)
    if header is None:
        return TenantTable(tenants=(), continued=False, rejected=0)

    columns = _columns_of(header)
    rows = _data_rows(table, header, total_columns=int(table["number of columns"]))
    owners = _name_owners(rows, columns)

    parsed = _to_tenants(rows, columns, owners)
    usable = tuple(tenant for tenant in parsed if _is_usable(tenant))
    return TenantTable(
        tenants=usable,
        # 괘선 파서는 문서 전체를 받으므로 표가 잘릴 일이 없다 — 쪽 상한 때문에 뒷쪽을
        # 못 읽던 텍스트 레이어 경로의 한계가 여기서는 발생하지 않는다
        continued=False,
        rejected=len(parsed) - len(usable),
    )


def _tables(node: Any, found: list[dict[str, Any]]) -> None:
    if isinstance(node, dict):
        if node.get("type") == "table":
            found.append(node)
        for value in node.values():
            _tables(value, found)
    elif isinstance(node, list):
        for value in node:
            _tables(value, found)


def _tenant_table(document: dict[str, Any]) -> dict[str, Any] | None:
    """점유자 표를 고른다 — 머리글에 "정보출처"가 있는 표가 그것이다.

    명세서는 양식 전체가 하나의 괘선 표라서 사건정보·비고까지 같은 표에 들어온다(실측
    14행×17열). 표를 고른 뒤 머리글 행으로 다시 좁힌다.
    """
    found: list[dict[str, Any]] = []
    _tables(document, found)
    for table in found:
        if any("정보출처" in _cell_text(cell) for row in table.get("rows", []) for cell in row.get("cells", [])):
            return table
    return None


def _cell_text(cell: dict[str, Any]) -> str:
    parts: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            content = node.get("content")
            if isinstance(content, str):
                parts.append(content)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(cell)
    return " ".join(parts).strip()


def _header_row(table: dict[str, Any]) -> dict[str, Any] | None:
    for row in table.get("rows", []):
        if any("정보출처" in _cell_text(cell) for cell in row.get("cells", [])):
            return row
    return None


def _columns_of(header: dict[str, Any]) -> dict[str, range]:
    """머리글 셀이 덮는 컬럼 범위를 컬럼 이름에 대응시킨다.

    머리글도 가로 병합이 있어(실측 "보 증 금"이 3칸) 컬럼 번호 하나로는 값을 못 찾는다.
    """
    columns: dict[str, range] = {}
    for cell in header.get("cells", []):
        text = _squeeze(_cell_text(cell))
        for marker, field in _HEADER_FIELDS:
            if field not in columns and marker in text:
                start = int(cell["column number"])
                columns[field] = range(start, start + int(cell["column span"]))
                break
    return columns


def _data_rows(
    table: dict[str, Any], header: dict[str, Any], *, total_columns: int
) -> list[dict[str, Any]]:
    """머리글 다음부터 표가 끝날 때까지의 행. 전 컬럼을 덮는 행에서 멈춘다.

    명세서는 점유자 표 아래에 <비고>·주의사항이 이어지는데, 그 줄들은 한 셀이 폭 전체를
    덮는다. 그것을 경계로 쓴다 — 문구를 찾는 것보다 구조가 안정적이다.
    """
    rows: list[dict[str, Any]] = []
    seen_header = False
    for row in table.get("rows", []):
        if row is header:
            seen_header = True
            continue
        if not seen_header:
            continue
        cells = row.get("cells", [])
        if any(int(cell["column span"]) >= total_columns for cell in cells):
            break
        if cells:
            rows.append(row)
    return rows


def _name_owners(rows: list[dict[str, Any]], columns: dict[str, range]) -> dict[int, int]:
    """행 번호 -> 그 행이 속한 사람의 순번(tenant_seq).

    성명 병합셀이 덮는 행들이 한 사람이다. 성명 셀이 없는 행은 위쪽 병합셀에 덮인 행이므로
    그 사람에 붙는다. 성명이 아예 없는 문서를 대비해, 덮이지 않은 행은 자기 순번을 갖는다.
    """
    name_range = columns.get("tenant_name")
    owners: dict[int, int] = {}
    if name_range is None:
        return {int(row["row number"]): index for index, row in enumerate(rows, start=1)}

    seq = 0
    for row in rows:
        row_no = int(row["row number"])
        cell = _cell_in(row, name_range)
        if cell is not None:
            seq += 1
            for offset in range(int(cell["row span"])):
                owners.setdefault(row_no + offset, seq)
        elif row_no not in owners:
            # 위 병합셀에 덮이지 않았는데 성명도 없다 — 새 사람으로 연다
            seq += 1
            owners[row_no] = seq
    return owners


def _cell_in(row: dict[str, Any], columns: range) -> dict[str, Any] | None:
    for cell in row.get("cells", []):
        start = int(cell["column number"])
        if start in columns:
            return cell
    return None


def _value(row: dict[str, Any], columns: dict[str, range], field: str) -> str | None:
    span = columns.get(field)
    if span is None:
        return None
    cell = _cell_in(row, span)
    if cell is None:
        return None
    text = _cell_text(cell)
    text = text if field in _KEEP_SPACES else _squeeze(text)
    return text or None


def _squeeze(text: str) -> str:
    return "".join(text.split())


def _to_tenants(
    rows: list[dict[str, Any]], columns: dict[str, range], owners: dict[int, int]
) -> tuple[NoticeTenant, ...]:
    tenants: list[NoticeTenant] = []
    for row_no, row in enumerate(rows, start=1):
        demanded_text = _value(row, columns, "demanded_distribution")
        demanded_date = _parse_date(demanded_text)
        deposit_text = _value(row, columns, "deposit_amount")
        fixed_text = _value(row, columns, "fixed_date")
        tenants.append(
            NoticeTenant(
                row_no=row_no,
                tenant_seq=owners.get(int(row["row number"]), row_no),
                tenant_name=_value(row, columns, "tenant_name"),
                source_kind=_value(row, columns, "source_kind"),
                occupied_part=_value(row, columns, "occupied_part"),
                possession_basis=_value(row, columns, "possession_basis"),
                lease_period=_value(row, columns, "lease_period"),
                deposit_amount=_parse_amount(deposit_text),
                monthly_rent=_parse_amount(_value(row, columns, "monthly_rent")),
                move_in_date=_parse_date(_value(row, columns, "move_in_date")),
                fixed_date=_parse_date(fixed_text),
                demanded_distribution=_parse_demanded(demanded_text, demanded_date),
                demanded_distribution_date=demanded_date,
                demanded_distribution_raw=demanded_text,
                deposit_tranches=_parse_deposit_tranches(deposit_text, fixed_text),
            )
        )
    return tuple(tenants)
