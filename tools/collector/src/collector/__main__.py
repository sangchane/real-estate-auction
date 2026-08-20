from __future__ import annotations

import argparse
import logging
import sys
import uuid

from collector.config import load_config
from collector.court_client import CourtAuctionClient
from collector.court_parser import parse_search_page
from collector.notice_document_client import NoticeDocumentClient
from collector.postgres_repository import PostgresAuctionRepository, run_migrations
from collector.runner import (
    CollectionTarget,
    run_collection,
    run_daily,
    run_notice_collection,
    run_photo_collection,
    run_sale_result_backfill,
    run_sale_result_sweep,
)


# daily 기본 대상 법원 — 서울 5개 지방법원.
# 코드는 실측으로 확정했다(2026-08-04). B000214는 의정부라 서울이 아니어서 뺐다.
#   B000210 서울중앙 / B000211 서울동부 / B000212 서울남부 / B000213 서울북부 / B000215 서울서부
#
# 남부·북부·서부를 추가하면 대상이 469 → 약 2,500건으로 는다. 명세서는 물건당 5요청 이상이라
# 한 번에 다 받을 수 없고, 법원이 조용히 빈 응답으로 degrade하는 벽(§4-10)이 실측 180건 근처다.
# 그래서 **기일이 가까운 물건부터** 받고(run_daily가 maeGiil 오름차순 정렬), 못 받은 것은
# 다음 실행으로 넘긴다. 명세서는 기일이 지나면 영구 소실이라 이 우선순위가 곧 손실 최소화다.
DAILY_DEFAULT_COURTS = ["B000210", "B000211", "B000212", "B000213", "B000215"]


def main() -> None:
    # 첫 인자로 모드를 고른다. 기존 호출(`--court-office-code ...`)은 그대로 물건 수집으로 동작한다.
    argv = sys.argv[1:]
    if argv and argv[0] == "backfill":
        _run_backfill(argv[1:])
    elif argv and argv[0] == "sweep":
        _run_sweep(argv[1:])
    elif argv and argv[0] == "notices":
        _run_notices(argv[1:])
    elif argv and argv[0] == "photos":
        _run_photos(argv[1:])
    elif argv and argv[0] == "daily":
        _run_daily(argv[1:])
    elif argv and argv[0] == "mask":
        _run_mask(argv[1:])
    else:
        _run_collect(argv)


def _run_collect(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(description="Court auction collector")
    parser.add_argument("--court-office-code", required=True)
    parser.add_argument("--page-no", type=int, default=1)
    parser.add_argument("--migrate", action="store_true")
    args = parser.parse_args(argv)

    client, repository = _bootstrap(migrate=args.migrate)
    run_collection(
        run_id=str(uuid.uuid4()),
        target=CollectionTarget(court_office_code=args.court_office_code, page_no=args.page_no),
        client=client,
        repository=repository,
        parse_search_page=parse_search_page,
    )


def _run_backfill(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        prog="collector backfill",
        description="매각기일이 지난 물건의 결과를 경매사건검색으로 채운다",
    )
    parser.add_argument("--limit", type=int, default=None, help="이번 실행에서 조회할 최대 사건 수")
    parser.add_argument("--migrate", action="store_true")
    args = parser.parse_args(argv)

    client, repository = _bootstrap(migrate=args.migrate)
    run_sale_result_backfill(
        run_id=str(uuid.uuid4()),
        client=client,
        repository=repository,
        limit=args.limit,
    )


def _run_sweep(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        prog="collector sweep",
        description="매각결과검색으로 최근 7일 매각/유찰 결과를 수집한다",
    )
    parser.add_argument("--court-office-code", required=True)
    parser.add_argument(
        "--status",
        choices=["", "02", "03"],
        default="",
        help="물건 상태 필터: 빈값=전체, 02=매각, 03=유찰",
    )
    parser.add_argument("--max-pages", type=int, default=50)
    parser.add_argument("--migrate", action="store_true")
    args = parser.parse_args(argv)

    client, repository = _bootstrap(migrate=args.migrate)
    run_sale_result_sweep(
        run_id=str(uuid.uuid4()),
        court_office_code=args.court_office_code,
        client=client,
        repository=repository,
        status_code=args.status,
        max_pages=args.max_pages,
    )


def _run_notices(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        prog="collector notices",
        description="지금 공고 중인 물건의 매각물건명세서 기재사항을 수집한다",
    )
    parser.add_argument("--court-office-code", required=True)
    parser.add_argument("--page-no", type=int, default=1)
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="이번 실행에서 상세조회할 최대 물건 수 (물건당 요청 1회)",
    )
    parser.add_argument(
        "--with-tenants",
        action="store_true",
        help="명세서 PDF까지 열어 점유자(임차인) 표를 함께 수집한다 (물건당 요청 3회 이상 추가)",
    )
    parser.add_argument("--migrate", action="store_true")
    args = parser.parse_args(argv)

    client, repository = _bootstrap(migrate=args.migrate)
    document_reader = None
    if args.with_tenants:
        config = load_config()
        document_reader = NoticeDocumentClient(
            request_interval_ms=config.request_interval_ms,
            max_retry=config.max_retry,
        )

    run_notice_collection(
        run_id=str(uuid.uuid4()),
        target=CollectionTarget(court_office_code=args.court_office_code, page_no=args.page_no),
        client=client,
        repository=repository,
        limit=args.limit,
        document_reader=document_reader,
    )


def _run_photos(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        prog="collector photos",
        description="사진이 아직 없는 사건의 물건 사진을 수집한다 (사건당 요청 1회)",
    )
    parser.add_argument("--court-office-code", default=None, help="법원 필터 (없으면 전체)")
    parser.add_argument(
        "--limit",
        type=int,
        default=5,
        help="이번 실행에서 조회할 최대 사건 수 (사건당 사진이 수 MB일 수 있다)",
    )
    parser.add_argument("--migrate", action="store_true")
    args = parser.parse_args(argv)

    client, repository = _bootstrap(migrate=args.migrate)
    run_photo_collection(
        run_id=str(uuid.uuid4()),
        client=client,
        repository=repository,
        court_office_code=args.court_office_code,
        limit=args.limit,
    )


def _run_mask(argv: list[str]) -> None:
    parser = argparse.ArgumentParser(
        prog="collector mask",
        description="배당종결된 사건의 점유자 성명을 지운다 (NF-03). daily 5단계와 같은 동작이다",
    )
    parser.add_argument("--migrate", action="store_true")
    args = parser.parse_args(argv)

    _, repository = _bootstrap(migrate=args.migrate)
    masked = repository.mask_ended_case_tenant_names()
    remaining = repository.count_unmasked_tenant_names()
    logging.getLogger(__name__).info(
        "masking_done masked=%s unmasked_remaining=%s", masked, remaining
    )


def _daily_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="collector daily",
        description="하루 1회 전체 수집 — 물건(전 페이지) → 명세서(없는 물건만) → 매각결과 → 사진",
    )
    parser.add_argument(
        "--court-office-code",
        default=None,
        help="법원 1곳만 돌 때 지정 (기본: 서울중앙 B000210 + 서울동부 B000211)",
    )
    parser.add_argument(
        "--max-pages", type=int, default=50, help="법원당 검색 페이지 상한 (안전장치)"
    )
    parser.add_argument(
        "--notice-limit", type=int, default=None, help="명세서 상세조회할 최대 물건 수"
    )
    parser.add_argument(
        # 텍스트 레이어로 읽은 명세서를 PDF 괘선으로 다시 받는 회차당 상한. 상한이 없으면 한
        # 회차에 전 명세서를 다시 받아 법원이 조용히 degrade한다 (WP-11 §4-3).
        # 신규 수집에는 걸리지 않는다 — 창이 닫히면 영구 소실이라 막으면 안 된다.
        "--rescan-limit", type=int, default=40, help="PDF 재수집 회차당 상한 (0이면 재수집 안 함)"
    )
    parser.add_argument(
        "--backfill-limit", type=int, default=None, help="매각 결과를 조회할 최대 사건 수"
    )
    parser.add_argument(
        "--photo-limit", type=int, default=None, help="사진을 조회할 최대 사건 수"
    )
    parser.add_argument(
        "--with-tenants",
        action="store_true",
        help="명세서 PDF까지 열어 점유자(임차인) 표를 함께 수집한다 (문서당 3요청+쪽당 1요청 — 기본 비활성)",
    )
    parser.add_argument("--migrate", action="store_true")
    return parser


def _run_daily(argv: list[str]) -> None:
    args = _daily_arg_parser().parse_args(argv)

    client, repository = _bootstrap(migrate=args.migrate)
    document_reader = None
    if args.with_tenants:
        config = load_config()
        document_reader = NoticeDocumentClient(
            request_interval_ms=config.request_interval_ms,
            max_retry=config.max_retry,
        )

    summary = run_daily(
        run_id=str(uuid.uuid4()),
        court_office_codes=(
            [args.court_office_code] if args.court_office_code else DAILY_DEFAULT_COURTS
        ),
        client=client,
        repository=repository,
        parse_search_page=parse_search_page,
        document_reader=document_reader,
        max_search_pages=args.max_pages,
        notice_limit=args.notice_limit,
        rescan_limit=args.rescan_limit,
        backfill_limit=args.backfill_limit,
        photo_limit=args.photo_limit,
    )
    # 단계 실패를 0으로 끝내면 cron에 성공으로 보인다 — 종료 코드로 드러낸다 (WP-09 notify와 같은 패턴)
    if summary.stage_failures:
        sys.exit(1)


def _bootstrap(*, migrate: bool) -> tuple[CourtAuctionClient, PostgresAuctionRepository]:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = load_config()
    if migrate:
        run_migrations(config.database_url)

    client = CourtAuctionClient(
        base_url=config.court_base_url,
        request_interval_ms=config.request_interval_ms,
        max_retry=config.max_retry,
    )
    return client, PostgresAuctionRepository(config.database_url)


if __name__ == "__main__":
    main()
