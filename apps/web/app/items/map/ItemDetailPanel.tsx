// 마커 클릭 시 지도 옆에 열리는 패널 — 페이지를 떠나지 않고 물건을 확인한다.
// 지도 탐색 중 화면이 통째로 바뀌면 줌·위치·주변 물건이라는 맥락이 끊긴다(네이버 지도와 같은 방식).
//
// 한 마커가 물건 여럿을 담을 수 있다. 같은 지번의 다세대·오피스텔은 좌표가 완전히 같아서
// 마커를 따로 찍으면 서로 가려진다(실측: 한 지점에 362건). 그래서 묶음이면 목록을 먼저 보이고,
// 한 줄을 고르면 그 물건의 상세로 들어간다.
//
// 상세는 탭 두 개를 한 패널에서 갈아 끼운다: 요약(상세 페이지와 같은 내용) ↔ 권리분석.
// 탭을 바꿔도 패널 폭은 그대로다 — 폭이 바뀌면 옆의 지도가 같이 밀려 탐색 맥락이 흔들린다.
'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FavoriteButton } from '../components/FavoriteButton';
import { AffordabilityCustomBid } from '../components/AffordabilityCustomBid';
import { RightsAnalysisView } from '../components/RightsAnalysisView';
import {
  computeMinimumBidRate,
  formatAreaWithKind,
  formatBidDatetime,
  formatDday,
  formatDropRate,
  formatWon,
  formatWonCompact,
  unitLabel,
} from '../format';
import { encodeItemId } from '../item-id';
import type { Affordability } from '../affordability';
import type { NoticeAnalysis } from '../notice-analysis';
import { assumedRightsLabel, riskFlagLabels, shortUsageName, tenantLabel } from '../notice-labels';
import { noticePdfSrc, photoAlt, photoProxySrc, type AuctionItemPhoto } from '../photo';
import { isBulkLot } from './bulk-lot';
import styles from './ItemDetailPanel.module.css';

export interface PanelItem {
  courtOfficeCode: string;
  caseNo: string;
  itemNo: string;
  courtName: string | null;
  deptName: string | null;
  usageName: string | null;
  areaKind: string | null;
  areaM2: number | null;
  bulkSale: boolean;
  address: string | null;
  appraisalAmount: number | null;
  minimumSalePrice: number | null;
  failedBidCount: number | null;
  bidDatetime: string | null;
  assumedRightsKind: string | null;
  riskFlags: string[];
  tenantCount: number | null;
  /** 명세서 기반 인수 보증금. null은 "명세서 미확인"이지 "인수 없음"이 아니다. */
  assumedDeposit: { amount: number; isLowerBound: boolean } | null;
}

/**
 * 패널 구획. 스크롤로 길게 늘어놓지 않고 왼쪽 아이콘 레일로 갈라 **한 번에 한 가지**만 보여준다.
 *
 * 지도 탐색 중에는 스크롤이 특히 불리하다 — 아래로 내리는 동안 지금 어느 물건을 보고 있었는지,
 * 무엇을 확인하려 했는지 놓친다. 구획이 나뉘어 있으면 원하는 것만 바로 찍어서 본다.
 *
 * 아이콘만 두지 않고 라벨을 함께 쓴다. 아이콘 하나로 "권리분석"과 "실부담"을 구별하게 하면
 * 매번 짐작하게 된다.
 */
const PANEL_VIEWS = [
  { key: 'summary', icon: '🏠', label: '개요' },
  { key: 'photos', icon: '🖼', label: '사진' },
  { key: 'rights', icon: '⚖', label: '권리분석' },
  { key: 'cost', icon: '💰', label: '실부담' },
] as const;

type PanelView = (typeof PANEL_VIEWS)[number]['key'];

/** 묶음의 공통 주소 — 호수를 떼면 같은 건물을 가리키는 부분만 남는다. */
function groupAddress(items: PanelItem[]): string | null {
  const first = items[0]?.address ?? null;
  if (first === null) return null;
  const unit = unitLabel(first);
  if (unit === null) return first;
  return first.replace(unit, '').replace(/\s+/g, ' ').trim();
}

export function ItemDetailPanel({ items, onClose }: { items: PanelItem[]; onClose: () => void }) {
  const [pickedId, setPickedId] = useState<string | null>(null);

  // 다른 마커를 누르면 선택을 지운다 — 앞 묶음에서 고른 물건이 그대로 남으면 안 된다.
  const groupId = items.map((item) => encodeItemId(item)).join('|');
  useEffect(() => {
    setPickedId(null);
  }, [groupId]);

  const picked =
    items.length === 1
      ? (items[0] ?? null)
      : (items.find((item) => encodeItemId(item) === pickedId) ?? null);

  if (picked === null) {
    return <GroupList items={items} onClose={onClose} onPick={setPickedId} />;
  }

  return (
    <ItemDetail
      item={picked}
      onClose={onClose}
      onBack={items.length > 1 ? () => setPickedId(null) : null}
    />
  );
}

function GroupList({
  items,
  onClose,
  onPick,
}: {
  items: PanelItem[];
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const address = groupAddress(items);
  // 일괄매각이면 최저가가 목적물별 값이 아니라 묶음 전체 값이다 — 줄마다 붙이면
  // "이 1.1평 상가가 421억"으로 읽힌다. 묶음에 한 번만 적는다.
  const bulkLot = isBulkLot(items);
  const lotPrice = bulkLot ? (items[0]?.minimumSalePrice ?? null) : null;

  return (
    <aside className={styles.panel} aria-label="이 위치의 물건 목록">
      <div className={styles.header}>
        <span className={styles.court}>
          {bulkLot ? `일괄매각 · 목적물 ${items.length}개` : `이 위치 ${items.length}건`}
        </span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>

      <h2 className={styles.address}>{address ?? '주소 정보 없음'}</h2>

      {bulkLot ? (
        <div className={styles.lotNotice}>
          <span className={styles.price}>
            {lotPrice !== null ? formatWon(lotPrice) : '가격 정보 없음'}
          </span>
          <p className={styles.lotNoticeText}>
            사건 {items[0]?.caseNo}의 목적물 {items.length}개를 한 번에 매각해요. 위 금액은 개별
            호수가 아니라 묶음 전체의 최저가예요.
          </p>
        </div>
      ) : null}

      <ul className={styles.list}>
        {items.map((item) => {
          const id = encodeItemId(item);
          const unit = unitLabel(item.address);
          const dday = formatDday(item.bidDatetime);
          const drop = formatDropRate(item.appraisalAmount, item.minimumSalePrice);
          const meta = [
            shortUsageName(item.usageName),
            formatAreaWithKind(item.areaM2, item.areaKind),
            item.failedBidCount !== null ? `유찰 ${item.failedBidCount}회` : null,
          ].filter((value): value is string => value !== null);

          return (
            <li key={id}>
              <button type="button" className={styles.listRow} onClick={() => onPick(id)}>
                <span className={styles.listTop}>
                  {/* 호수가 없는 물건(토지·단독)은 물건번호로 구분한다 */}
                  <span className={styles.listUnit}>{unit ?? `물건 ${item.itemNo}`}</span>
                  {dday ? <span className={styles.dday}>{dday}</span> : null}
                </span>
                <span className={styles.listMeta}>{meta.join(' · ')}</span>
                {/* 일괄매각이면 목적물별 가격이 없다 — 위에 묶음 가격을 한 번 적었다 */}
                {bulkLot ? null : (
                  <span className={styles.listPrice}>
                    {item.minimumSalePrice !== null
                      ? formatWonCompact(item.minimumSalePrice)
                      : '가격 정보 없음'}
                    {drop ? <span className={styles.drop}>{drop}</span> : null}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function ItemDetail({
  item,
  onClose,
  onBack,
}: {
  item: PanelItem;
  onClose: () => void;
  onBack: (() => void) | null;
}) {
  const [photos, setPhotos] = useState<AuctionItemPhoto[]>([]);
  const [view, setView] = useState<PanelView>('summary');
  // 권리분석은 탭을 눌렀을 때만 받는다 — 지도에서 훑기만 하는 사용자에게 요청을 만들지 않는다.
  const [analysis, setAnalysis] = useState<NoticeAnalysis | null | undefined>(undefined);
  const [affordability, setAffordability] = useState<Affordability | null | undefined>(undefined);
  const pathname = usePathname();
  const id = encodeItemId(item);

  // 다른 물건을 고르면 요약부터 다시 본다 — 앞 물건의 권리분석 화면이 그대로 남으면
  // 새 물건의 분석으로 오인된다.
  useEffect(() => {
    setView('summary');
  }, [item.courtOfficeCode, item.caseNo, item.itemNo]);

  // 사진은 bbox 응답에 없어 패널을 열 때만 받는다 — 지도의 수백 건에 미리 붙일 이유가 없다.
  useEffect(() => {
    let cancelled = false;
    setPhotos([]);
    const url = `/api/auction-items/${encodeURIComponent(item.courtOfficeCode)}/${encodeURIComponent(item.caseNo)}/${encodeURIComponent(item.itemNo)}/photos`;
    fetch(url)
      .then((response) => (response.ok ? response.json() : []))
      .then((data: unknown) => {
        if (!cancelled && Array.isArray(data)) setPhotos(data as AuctionItemPhoto[]);
      })
      .catch(() => {
        // 사진은 보조 정보다 — 실패해도 패널의 나머지는 그대로 쓸 수 있게 조용히 넘어간다
      });
    return () => {
      cancelled = true;
    };
  }, [item.courtOfficeCode, item.caseNo, item.itemNo]);

  // 권리분석 탭을 처음 열 때 명세서 분석을 받는다. 물건이 바뀌면 다시 받는다.
  useEffect(() => {
    if (view !== 'rights') return;
    let cancelled = false;
    const base = `/api/auction-items/${encodeURIComponent(item.courtOfficeCode)}/${encodeURIComponent(item.caseNo)}/${encodeURIComponent(item.itemNo)}`;
    fetch(`${base}/notice-analysis`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        // 404(명세서 미수집)와 오류를 모두 null로 둔다 — 화면은 "확인되지 않음"으로 말한다
        if (!cancelled) setAnalysis((data as NoticeAnalysis | null) ?? null);
      })
      .catch(() => {
        if (!cancelled) setAnalysis(null);
      });
    // 실부담은 보조 정보다 — 실패해도 권리분석의 나머지는 그대로 쓸 수 있게 null로 둔다
    fetch(`${base}/affordability`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: unknown) => {
        if (!cancelled) setAffordability((data as Affordability | null) ?? null);
      })
      .catch(() => {
        if (!cancelled) setAffordability(null);
      });
    return () => {
      cancelled = true;
    };
  }, [view, item.courtOfficeCode, item.caseNo, item.itemNo]);

  // 물건이 바뀌면 앞 물건의 분석이 남지 않게 지운다 — 남으면 다른 물건의 인수액으로 읽힌다.
  useEffect(() => {
    setAnalysis(undefined);
    setAffordability(undefined);
  }, [item.courtOfficeCode, item.caseNo, item.itemNo]);

  // Esc — 한 단계씩만 되돌린다. 넓어진 패널이나 목록이 통째로 닫히면 방금 보던 물건을
  // 지도에서 다시 찾아야 한다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (view === 'rights') setView('summary');
      else if (onBack) onBack();
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, onClose, view]);

  const usage = shortUsageName(item.usageName);
  const dday = formatDday(item.bidDatetime);
  const drop = formatDropRate(item.appraisalAmount, item.minimumSalePrice);
  const minimumBidRate = computeMinimumBidRate(item.appraisalAmount, item.minimumSalePrice);
  const bidDatetimeLabel = formatBidDatetime(item.bidDatetime);
  const rights = assumedRightsLabel(item.assumedRightsKind);
  const tenants = tenantLabel(item.tenantCount);
  const flags = riskFlagLabels(item.riskFlags);
  const noticeMissing = rights === null && tenants === null && flags.length === 0;

  // 면적은 평·㎡ 둘 다 — 평이 익숙한 사람과 ㎡가 익숙한 사람이 갈린다.
  const areaText = formatAreaWithKind(item.areaM2, item.areaKind);

  const meta = [
    usage,
    areaText,
    item.failedBidCount !== null ? `유찰 ${item.failedBidCount}회` : null,
  ].filter((value): value is string => value !== null);

  return (
    <aside className={styles.panel} aria-label="물건 정보">
      {/* 왼쪽 아이콘 레일 — 구획을 나눠 한 번에 한 가지만 보게 한다(스크롤 대신) */}
      <nav className={styles.rail} role="tablist" aria-label="물건 정보 구획">
        {PANEL_VIEWS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={view === entry.key}
            className={view === entry.key ? `${styles.railItem} ${styles.railItemActive}` : styles.railItem}
            onClick={() => setView(entry.key)}
          >
            <span className={styles.railIcon} aria-hidden="true">
              {entry.icon}
            </span>
            <span className={styles.railLabel}>{entry.label}</span>
          </button>
        ))}
      </nav>

      <div className={styles.body}>
      <div className={styles.header}>
        {onBack ? (
          <button type="button" className={styles.back} onClick={onBack}>
            ← 목록
          </button>
        ) : null}
        <span className={styles.court}>
          {item.courtName} {item.deptName} · {item.caseNo}
        </span>
        <button type="button" className={styles.close} onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>

      <h2 className={styles.address}>{item.address ?? '주소 정보 없음'}</h2>

      <div className={styles.meta}>
        {meta.map((value, index) => (
          <span key={value}>
            {index > 0 ? <span className={styles.metaDivider}>·</span> : null} {value}
          </span>
        ))}
        {dday ? (
          <>
            {meta.length > 0 ? <span className={styles.metaDivider}>·</span> : null}
            <span className={styles.dday}>{dday}</span>
          </>
        ) : null}
      </div>

      {view === 'summary' ? (
        <>
          <div className={styles.priceBlock}>
            <div className={styles.priceRow}>
              <span className={styles.price}>
                {item.minimumSalePrice !== null ? formatWon(item.minimumSalePrice) : '가격 정보 없음'}
              </span>
              {drop ? <span className={styles.drop}>{drop}</span> : null}
            </div>
            <div className={styles.appraisal}>
              {item.appraisalAmount !== null ? `감정가 ${formatWonCompact(item.appraisalAmount)}` : null}
              {minimumBidRate !== null ? (
                <span className={styles.minRate}>최저가율 {minimumBidRate}%</span>
              ) : null}
            </div>
          </div>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>매각물건명세서</h3>
            {noticeMissing ? (
              <p className={styles.unknown}>
                아직 명세서를 받지 못했어요. 인수할 권리가 없다는 뜻이 아니라 확인되지 않았다는
                뜻이에요.
              </p>
            ) : (
              <div className={styles.chips}>
                {tenants ? <span className={styles.chip}>{tenants}</span> : null}
                {rights ? <span className={styles.chip}>{rights}</span> : null}
                {flags.map((flag) => (
                  <span key={flag} className={styles.chip}>
                    {flag}
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>물건 개요</h3>
            <div className={styles.specs}>
              <span className={styles.specsLabel}>사건번호</span>
              <span className={styles.specsValue}>{item.caseNo}</span>
              <span className={styles.specsLabel}>물건종류</span>
              <span className={styles.specsValue}>{item.usageName ?? '정보 없음'}</span>
              <span className={styles.specsLabel}>면적</span>
              <span className={styles.specsValue}>{areaText ?? '정보 없음'}</span>
              <span className={styles.specsLabel}>매각기일</span>
              <span className={styles.specsValue}>{bidDatetimeLabel ?? '정보 없음'}</span>
              <span className={styles.specsLabel}>유찰</span>
              <span className={styles.specsValue}>
                {item.failedBidCount !== null ? `${item.failedBidCount}회` : '정보 없음'}
              </span>
              <span className={styles.specsLabel}>담당계</span>
              <span className={styles.specsValue}>{item.deptName ?? '정보 없음'}</span>
            </div>
          </section>
        </>
      ) : view === 'photos' ? (
        <div className={styles.viewBody}>
          {photos.length > 0 ? (
            <div className={styles.photoGrid}>
              {photos.map((photo) => (
                // next/image 대신 <img> — 상세 화면과 같은 프록시 경로를 그대로 쓴다
                <img
                  key={photo.id}
                  className={styles.photo}
                  src={photoProxySrc(photo.id)}
                  alt={photoAlt(photo)}
                  loading="lazy"
                />
              ))}
            </div>
          ) : (
            <p className={styles.unknown}>아직 사진을 받지 못했어요.</p>
          )}
        </div>
      ) : view === 'cost' ? (
        <div className={styles.viewBody}>
          {analysis === undefined ? (
            <p className={styles.unknown}>불러오는 중이에요...</p>
          ) : analysis === null ? (
            <p className={styles.unknown}>
              명세서를 아직 받지 못해 실부담을 계산할 수 없어요. 인수할 권리가 없다는 뜻이 아니에요.
            </p>
          ) : (
            <AffordabilityCustomBid
              courtOfficeCode={item.courtOfficeCode}
              caseNo={item.caseNo}
              itemNo={item.itemNo}
            />
          )}
        </div>
      ) : (
        <div className={styles.viewBody}>
          {analysis === undefined ? (
            <p className={styles.unknown}>권리분석을 불러오는 중이에요...</p>
          ) : (
            <RightsAnalysisView
              analysis={analysis}
              affordability={affordability}
              noticePdfUrl={noticePdfSrc(item)}
            />
          )}
        </div>
      )}

      <div className={styles.actions}>
        <FavoriteButton
          courtOfficeCode={item.courtOfficeCode}
          caseNo={item.caseNo}
          itemNo={item.itemNo}
          currentPath={pathname}
        />
        {/* 패널이 상세의 실질을 다 담으므로 이 링크는 공유·큰 화면용이다 — 지도 맥락을 잃지 않게
            새 탭으로 연다 (사용자 확정 2026-08-07: 패널 완결형) */}
        <Link
          href={`/items/${id}`}
          className={styles.secondaryLink}
          target="_blank"
          rel="noopener noreferrer"
        >
          상세 페이지 새 탭으로 ↗
        </Link>
      </div>
      </div>
    </aside>
  );
}
