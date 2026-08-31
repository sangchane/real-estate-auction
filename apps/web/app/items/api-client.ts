// apps/api의 물건 조회 엔드포인트를 호출하는 서버 전용 클라이언트 (WP-02 수집 데이터)
import { cache } from 'react';
import type { Affordability } from './affordability';
import type { DongBuildingAge } from './building-age';
import type { ItemKey } from './item-id';
import type { NoticeAnalysis } from './notice-analysis';
import type { AuctionItemPhoto } from './photo';
import type { RegistryState } from './registry';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';

export interface AuctionItem {
  courtOfficeCode: string;
  caseNo: string;
  itemNo: string;
  courtName: string | null;
  deptName: string | null;
  usageName: string | null;
  areaKind: string | null;
  /** 면적(㎡) — 건물이면 전용면적, 토지면 토지면적. 여럿이거나 없으면 null. */
  areaM2: number | null;
  /** true면 단가를 계산하지 않는다 — 면적과 가격의 단위가 어긋난다. */
  bulkSale: boolean;
  address: string | null;
  appraisalAmount: number | null;
  minimumSalePrice: number | null;
  failedBidCount: number | null;
  bidDatetime: string | null;
  // 매각물건명세서(법원 공고 사실) 기반 신호. null/빈 배열은 "확인하지 못했다"는 뜻이지
  // "해당 없음"이 아니다 — 화면에서 구분해 표기해야 한다.
  assumedRightsKind: string | null;
  riskFlags: string[];
  tenantCount: number | null;
  /**
   * 명세서 기반 인수 보증금. null은 "명세서를 아직 못 받았다"는 뜻이고,
   * `{ amount: 0, isLowerBound: false }`가 "인수 0원 확정"이다 — 둘을 같게 표기하면 안 된다.
   */
  assumedDeposit: { amount: number; isLowerBound: boolean } | null;
}

// generateMetadata와 페이지 컴포넌트가 같은 요청 안에서 중복 호출하지 않도록 React cache()로 묶는다
export const fetchAuctionItem = cache(async (key: ItemKey): Promise<AuctionItem | null> => {
  const url = `${API_BASE_URL}/auction-items/${encodeURIComponent(key.courtOfficeCode)}/${encodeURIComponent(key.caseNo)}/${encodeURIComponent(key.itemNo)}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`물건 조회 실패: ${response.status}`);
  }
  return (await response.json()) as AuctionItem;
});

/** 물건 상세의 사진 메타 목록 — 물건이 없으면(404) 빈 배열로 취급한다 (상세 본문이 이미 404를 처리한다) */
export async function fetchAuctionItemPhotos(key: ItemKey): Promise<AuctionItemPhoto[]> {
  const url = `${API_BASE_URL}/auction-items/${encodeURIComponent(key.courtOfficeCode)}/${encodeURIComponent(key.caseNo)}/${encodeURIComponent(key.itemNo)}/photos`;
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`물건 사진 조회 실패: ${response.status}`);
  }
  return (await response.json()) as AuctionItemPhoto[];
}

/**
 * 물건이 속한 법정동의 노후도 집계. 동 매칭이나 집계가 없으면 404이며 null로 돌려준다 —
 * 화면은 섹션을 그리지 않는다 (없는 사실을 0%로 그리지 않는다).
 */
export async function fetchDongBuildingAge(key: ItemKey): Promise<DongBuildingAge | null> {
  const url = `${API_BASE_URL}/zones/building-age/${encodeURIComponent(key.courtOfficeCode)}/${encodeURIComponent(key.caseNo)}/${encodeURIComponent(key.itemNo)}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`동 노후도 조회 실패: ${response.status}`);
  }
  return (await response.json()) as DongBuildingAge;
}

/**
 * 매각물건명세서 기반 권리분석. 명세서를 아직 못 받은 물건은 404이며 null로 돌려준다 —
 * 빈 결과를 주면 화면이 "인수할 권리 없음"으로 읽는다.
 */
export async function fetchNoticeAnalysis(key: ItemKey): Promise<NoticeAnalysis | null> {
  const url = `${API_BASE_URL}/auction-items/${encodeURIComponent(key.courtOfficeCode)}/${encodeURIComponent(key.caseNo)}/${encodeURIComponent(key.itemNo)}/notice-analysis`;
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`명세서 권리분석 조회 실패: ${response.status}`);
  }
  return (await response.json()) as NoticeAnalysis;
}

/** 실부담 시나리오. 명세서가 없는 물건은 404이며 null — 인수액을 모르는 채 계산하지 않는다 */
export async function fetchAffordability(key: ItemKey): Promise<Affordability | null> {
  const url = `${API_BASE_URL}/auction-items/${encodeURIComponent(key.courtOfficeCode)}/${encodeURIComponent(key.caseNo)}/${encodeURIComponent(key.itemNo)}/affordability`;
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`실부담 시나리오 조회 실패: ${response.status}`);
  }
  return (await response.json()) as Affordability;
}

export type ItemListSort = 'recent' | 'bidDate' | 'priceAsc' | 'priceDesc' | 'failedDesc';

export interface AuctionItemFilter {
  sido?: string;
  sigungu?: string;
  /** 용도 원문의 첫 조각 목록 (예: ['아파트','다세대']) — 범주 묶기는 usage-category가 안다 */
  usages?: string[];
  minPrice?: number;
  maxPrice?: number;
  sort?: ItemListSort;
}

/** 목록·건수가 같은 조건을 보게 쿼리를 한 곳에서 만든다 — 갈라지면 "전체 N건"이 어긋난다 */
function filterParams(filter: AuctionItemFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.sido) params.set('sido', filter.sido);
  if (filter.sigungu) params.set('sigungu', filter.sigungu);
  if (filter.usages && filter.usages.length > 0) params.set('usage', filter.usages.join(','));
  if (filter.minPrice !== undefined) params.set('minPrice', String(filter.minPrice));
  if (filter.maxPrice !== undefined) params.set('maxPrice', String(filter.maxPrice));
  return params;
}

/** 같은 조건의 전체 건수 — 조회 실패는 화면을 막지 않고 null로 둔다(건수는 보조 정보다) */
export async function fetchAuctionItemCount(
  filter: AuctionItemFilter = {},
): Promise<number | null> {
  try {
    const response = await fetch(
      `${API_BASE_URL}/auction-items/count?${filterParams(filter).toString()}`,
      { cache: 'no-store' },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { count: number };
    return body.count;
  } catch {
    return null;
  }
}

export async function fetchAuctionItems(
  limit: number,
  offset: number,
  filter: AuctionItemFilter = {},
): Promise<AuctionItem[]> {
  const params = filterParams(filter);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (filter.sort) params.set('sort', filter.sort);
  const response = await fetch(`${API_BASE_URL}/auction-items?${params.toString()}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`물건 목록 조회 실패: ${response.status}`);
  }
  return (await response.json()) as AuctionItem[];
}

export interface RegionCount {
  name: string;
  count: number;
}

export async function fetchRegionCounts(sido?: string): Promise<RegionCount[]> {
  const params = sido ? `?sido=${encodeURIComponent(sido)}` : '';
  const response = await fetch(`${API_BASE_URL}/auction-items/regions${params}`, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`지역 집계 조회 실패: ${response.status}`);
  }
  return (await response.json()) as RegionCount[];
}

/**
 * 등기부 보관본 상태 — **GET은 발급하지 않는다.** 이미 받아 둔 것이 있으면 돌려주고,
 * 없으면 "받으면 무엇을 조회하게 되는지"만 알려준다. 화면이 이 함수를 여러 번 불러도
 * 돈이 나가지 않는다 (열람 1건 700원 — D-008).
 */
export async function fetchRegistryState(key: ItemKey): Promise<RegistryState | null> {
  const url = `${API_BASE_URL}/auction-items/${encodeURIComponent(key.courtOfficeCode)}/${encodeURIComponent(key.caseNo)}/${encodeURIComponent(key.itemNo)}/registry`;
  const response = await fetch(url, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`등기부 보관본 조회 실패: ${response.status}`);
  }
  return (await response.json()) as RegistryState;
}
