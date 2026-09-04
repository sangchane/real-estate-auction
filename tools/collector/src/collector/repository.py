from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from collector.court_parser import AuctionItem, CasePhoto, ItemNotice, SaleResult


@dataclass(frozen=True)
class UpsertResult:
    inserted: int
    updated: int
    skipped: int
    # 저장에 실패한 건수. 한 건이 깨져도 나머지를 살리는 저장소에서만 0이 아니다 —
    # 실패를 세지 않으면 "받아왔는데 저장 안 됨"이 로그에서 성공처럼 보인다
    failed: int = 0


class InMemoryAuctionRepository:
    """멱등 upsert 규칙을 검증하기 위한 테스트용 저장소."""

    def __init__(self) -> None:
        self._items: dict[tuple[str, str, str], AuctionItem] = {}

    def upsert_items(self, items: list[AuctionItem]) -> UpsertResult:
        inserted = 0
        updated = 0
        skipped = 0

        for item in items:
            current = self._items.get(item.natural_key)
            if current is None:
                self._items = {**self._items, item.natural_key: item}
                inserted += 1
                continue
            if current == item:
                skipped += 1
                continue
            self._items = {**self._items, item.natural_key: item}
            updated += 1

        return UpsertResult(inserted=inserted, updated=updated, skipped=skipped)


class InMemoryNoticeRepository:
    """명세서 멱등 저장 규칙(같은 물건·작성일 중복 금지)을 검증하기 위한 테스트용 저장소."""

    def __init__(self, ended_item_keys: set[tuple[str, str, str]] | None = None) -> None:
        self.notices: dict[tuple[str, str, str, Any], ItemNotice] = {}
        # 배당종결(015)로 종료 판정된 물건 — 실제 저장소는 auction_sale_result로 판단한다
        self.ended_item_keys = ended_item_keys or set()

    def upsert_notices(self, notices: list[ItemNotice]) -> UpsertResult:
        inserted = 0
        updated = 0
        skipped = 0

        for notice in notices:
            key = (notice.court_office_code, notice.case_no, notice.item_no, notice.document_date)
            current = self.notices.get(key)
            # 스캔 표시는 한 번 서면 지워지지 않는다 — 저장소가 컬럼을 덮어쓰지 않고 세우기만 하는 것과 같다.
            # 이 흉내를 안 내면 "표 없이 재수집하면 스캔 기록이 사라지는" 회귀를 테스트가 통과시킨다
            if current is not None and current.tenants_scanned and not notice.tenants_scanned:
                notice = replace(
                    notice,
                    tenants_scanned=True,
                    tenants_rejected=current.tenants_rejected,
                    tenants_continued=current.tenants_continued,
                )
            if current is None:
                inserted += 1
            elif current == notice:
                skipped += 1
                continue
            else:
                updated += 1
            self.notices = {**self.notices, key: notice}

        return UpsertResult(inserted=inserted, updated=updated, skipped=skipped)

    def find_item_keys_with_notice(self) -> set[tuple[str, str, str, Any]]:
        """명세서를 가진 (물건, 그 명세서의 기일) 집합 — daily 스킵 필터 검증용."""
        return {
            (court, case_no, item_no, notice.bid_date)
            for (court, case_no, item_no, _), notice in self.notices.items()
        }

    def find_item_keys_with_tenant_scan(self) -> set[tuple[str, str, str, Any]]:
        """점유자 표 파싱까지 끝낸 (물건, 기일) 집합 — daily 재열람 필터 검증용."""
        return {
            (court, case_no, item_no, notice.bid_date)
            for (court, case_no, item_no, _), notice in self.notices.items()
            if notice.tenants_scanned
        }

    def find_item_keys_needing_pdf_rescan(self) -> set[tuple[str, str, str, Any]]:
        """인메모리 저장소는 스캔 시각을 모델링하지 않아 재수집 대상을 내지 않는다 (018).

        경과시간 조건이 재수집의 안전장치이므로, 그것을 흉내낼 수 없으면 대상을 내지 않는 쪽이
        맞다 — 흉내내면 테스트가 실제와 다른 동작을 검증하게 된다.
        """
        return set()

    def mask_ended_case_tenant_names(self) -> int:
        """종료 사건의 성명을 지운다 — 종료 판정은 주입된 ended_keys로 흉내낸다 (NF-03)."""
        masked = 0
        for key, notice in list(self.notices.items()):
            if key[:3] not in self.ended_item_keys:
                continue
            kept = tuple(
                replace(t, tenant_name=None) if t.tenant_name is not None else t
                for t in notice.tenants
            )
            masked += sum(1 for t in notice.tenants if t.tenant_name is not None)
            self.notices[key] = replace(notice, tenants=kept)
        return masked

    def count_unmasked_tenant_names(self) -> int:
        return sum(
            1
            for notice in self.notices.values()
            for tenant in notice.tenants
            if tenant.tenant_name is not None
        )

    def recompute_spatial_joins(self) -> int:
        """인메모리 저장소는 좌표·경계를 모델링하지 않아 붙일 것이 없다 (PostGIS 전용 단계).

        0을 돌려주는 것은 "미배정 없음"이 아니라 "셀 물건이 없음"이다 — 공간조인의 실제 동작은
        test_zone_join.py가 PostGIS에 대고 검증한다. 여기서 흉내내면 테스트가 실제와 다른 것을
        검증하게 된다 (find_item_keys_needing_pdf_rescan과 같은 판단).
        """
        return 0


class InMemoryPhotoRepository:
    """사진 멱등 저장 규칙(같은 사건·출처·순번 중복 금지)을 검증하기 위한 테스트용 저장소."""

    def __init__(self, pending_cases: list[dict[str, Any]] | None = None) -> None:
        self._pending_cases = list(pending_cases or [])
        self.photos: dict[tuple[str, str, str, int], CasePhoto] = {}

    def find_cases_missing_photos(
        self, court_office_code: str | None = None
    ) -> list[dict[str, Any]]:
        rows = [
            row
            for row in self._pending_cases
            if court_office_code is None or row["court_office_code"] == court_office_code
        ]
        collected = {(key[0], key[1]) for key in self.photos}
        return [
            row for row in rows if (row["court_office_code"], row["case_no"]) not in collected
        ]

    def upsert_case_photos(
        self, court_office_code: str, case_no: str, photos: list[CasePhoto]
    ) -> UpsertResult:
        inserted = 0
        updated = 0
        skipped = 0

        for photo in photos:
            key = (court_office_code, case_no, photo.source, photo.seq)
            current = self.photos.get(key)
            if current is None:
                inserted += 1
            elif current == photo:
                skipped += 1
                continue
            else:
                updated += 1
            self.photos = {**self.photos, key: photo}

        return UpsertResult(inserted=inserted, updated=updated, skipped=skipped)


class InMemorySaleResultRepository:
    """매각 결과 멱등 저장 규칙(같은 관측 튜플 중복 금지)을 검증하기 위한 테스트용 저장소."""

    def __init__(self, pending_items: list[dict[str, Any]] | None = None) -> None:
        self._pending_items = list(pending_items or [])
        self.rows: set[tuple[Any, ...]] = set()

    def find_items_pending_sale_result(self) -> list[dict[str, Any]]:
        return list(self._pending_items)

    def upsert_sale_results(self, results: list[SaleResult]) -> UpsertResult:
        inserted = 0
        skipped = 0

        for result in results:
            key = (
                result.court_office_code,
                result.case_no,
                result.item_no,
                result.dxdy_date,
                result.dxdy_kind_code,
                result.result_code,
                result.sale_amount,
            )
            if key in self.rows:
                skipped += 1
                continue
            self.rows = {*self.rows, key}
            inserted += 1

        return UpsertResult(inserted=inserted, updated=0, skipped=skipped)
