// 목록 필터의 순수 로직 — 상수·쿼리 해석·API 필터 변환.
// JSX와 분리한 이유: tsconfig.test.json에 jsx 옵션이 없어 컴포넌트 파일은 테스트에 넣을 수 없다.
// 이 저장소 선례대로 순수 함수만 테스트한다.
import { usageNamesOf, type UsageCategory } from '../map/usage-category';

/** OTHER는 "나머지 전부"라 용도명을 열거할 수 없어 필터에서 뺀다 (usageNamesOf 주석 참조) */
export const FILTERABLE_CATEGORIES: readonly UsageCategory[] = [
  'APARTMENT',
  'MULTI_HOUSE',
  'OFFICETEL',
  'DETACHED',
  'RETAIL',
  'LAND',
];

/**
 * 가격 구간. 경매 최저가 분포에 맞춘 값이고, 두 칸짜리 숫자 입력보다 훑기에 낫다.
 * 상한 없는 마지막 구간을 반드시 둔다 — 없으면 비싼 물건이 어디에도 안 걸린다.
 */
export const PRICE_RANGES = [
  { key: '~1e', label: '1억 이하', max: 100_000_000 },
  { key: '1-3e', label: '1~3억', min: 100_000_000, max: 300_000_000 },
  { key: '3-5e', label: '3~5억', min: 300_000_000, max: 500_000_000 },
  { key: '5-10e', label: '5~10억', min: 500_000_000, max: 1_000_000_000 },
  { key: '10e~', label: '10억 이상', min: 1_000_000_000 },
] as const;

export const SORTS = [
  { key: 'recent', label: '최근 수집순' },
  { key: 'bidDate', label: '기일 임박순' },
  { key: 'priceAsc', label: '낮은 가격순' },
  { key: 'priceDesc', label: '높은 가격순' },
  { key: 'failedDesc', label: '유찰 많은 순' },
] as const;

export interface FilterState {
  sigungu?: string;
  categories: UsageCategory[];
  priceKey?: string;
  sort: string;
}

/** 주소 쿼리 → 필터 상태. 모르는 값은 무시한다 — 손으로 주소를 고쳐도 화면이 깨지지 않게 */
export function parseFilters(query: {
  sigungu?: string;
  usage?: string;
  price?: string;
  sort?: string;
}): FilterState {
  const categories = (query.usage?.split(',') ?? []).filter((value): value is UsageCategory =>
    FILTERABLE_CATEGORIES.includes(value as UsageCategory),
  );
  const priceKey = PRICE_RANGES.some((range) => range.key === query.price)
    ? query.price
    : undefined;
  // 찾은 항목의 key를 쓴다 — some()으로 존재만 확인하고 원본을 쓰면 넌널 단언이 필요해진다(규칙 19)
  const sort = SORTS.find((option) => option.key === query.sort)?.key ?? 'recent';
  return { sigungu: query.sigungu || undefined, categories, priceKey, sort };
}

/** 필터 상태 → API 필터. 범주를 용도명으로 펴는 것이 화면과 API의 경계다. */
export function toApiFilter(state: FilterState): {
  sido?: string;
  sigungu?: string;
  usages?: string[];
  minPrice?: number;
  maxPrice?: number;
} {
  const range = PRICE_RANGES.find((option) => option.key === state.priceKey);
  const usages = state.categories.flatMap(usageNamesOf);
  return {
    sigungu: state.sigungu,
    usages: usages.length > 0 ? usages : undefined,
    minPrice: range && 'min' in range ? range.min : undefined,
    maxPrice: range && 'max' in range ? range.max : undefined,
  };
}

