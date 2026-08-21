// 법원 용도 원문 → 지도 마커의 건물 유형 범주. 마커 아이콘의 모양과 색을 고르는 근거다.
//
// 범주는 실측 분포(2,979건)를 덮도록 잡았다: 상가 804 · 다세대 662 · 연립주택 583 · 오피스텔 359 ·
// 기타 178 · 아파트 166 · 단독주택다가구 142 · 근린시설 115 · 대지 44 · 임야 43 · 단독주택 36 ·
// 다가구주택 28 · 자동차 28 · 전답 6 · 빌라 4.
//
// 색은 **범주 구분용이지 좋고 나쁨이 아니다.** 그래서 `warning`·`critical` 토큰은 쓰지 않는다
// (page.module.css의 markerDrop 주석과 같은 원칙 — 우리 판단을 색으로 넣지 않는다).
// 새 hex를 만들지 않고 DESIGN-meta.md 원문 토큰만 골라 쓴다.
import { shortUsageName } from '../notice-labels';

export type UsageCategory =
  | 'APARTMENT'
  | 'MULTI_HOUSE'
  | 'OFFICETEL'
  | 'DETACHED'
  | 'RETAIL'
  | 'LAND'
  | 'OTHER';

/** 법원이 콤마로 묶어 보내는 용도 원문의 **첫 조각**으로 판정한다 (shortUsageName과 같은 기준) */
const CATEGORY_BY_USAGE: Record<string, UsageCategory> = {
  아파트: 'APARTMENT',
  다세대: 'MULTI_HOUSE',
  연립주택: 'MULTI_HOUSE',
  빌라: 'MULTI_HOUSE',
  오피스텔: 'OFFICETEL',
  단독주택: 'DETACHED',
  단독주택다가구: 'DETACHED',
  다가구주택: 'DETACHED',
  주택: 'DETACHED',
  상가: 'RETAIL',
  근린시설: 'RETAIL',
  근린상가: 'RETAIL',
  점포: 'RETAIL',
  사무실: 'RETAIL',
  공장: 'RETAIL',
  창고: 'RETAIL',
  숙박시설: 'RETAIL',
  대지: 'LAND',
  토지: 'LAND',
  임야: 'LAND',
  전답: 'LAND',
  전: 'LAND',
  답: 'LAND',
};

/** 모르는 용도는 OTHER — 조용히 아파트 등으로 넘기면 지도가 사실과 다른 말을 한다 */
export function usageCategory(usageName: string | null): UsageCategory {
  const short = shortUsageName(usageName);
  if (short === null) return 'OTHER';
  return CATEGORY_BY_USAGE[short] ?? 'OTHER';
}

/** 범례·접근성 라벨. 마커에는 아이콘만 보이므로 aria-label로 함께 내보낸다 */
/**
 * 범주에 속하는 용도 원문 목록 — 목록 필터가 API에 보낼 값이다.
 *
 * API는 범주를 모르고 용도명만 받는다(매핑이 두 곳에 생기면 갈라진다). 이 함수가 그 경계다.
 * OTHER는 "나머지 전부"라 이름을 열거할 수 없다 — 빈 배열을 주고 화면이 필터에서 뺀다.
 */
export function usageNamesOf(category: UsageCategory): string[] {
  return Object.entries(CATEGORY_BY_USAGE)
    .filter(([, value]) => value === category)
    .map(([name]) => name);
}

export const USAGE_CATEGORY_LABEL: Record<UsageCategory, string> = {
  APARTMENT: '아파트',
  MULTI_HOUSE: '다세대·연립',
  OFFICETEL: '오피스텔',
  DETACHED: '단독·다가구',
  RETAIL: '상가·근린',
  LAND: '토지',
  OTHER: '그 밖의 용도',
};

/**
 * 범주별 아이콘 SVG 본문(12×12, `currentColor` 사용 — 색은 CSS 클래스가 정한다).
 * 토지·그 밖은 건물이 아니라서 건물 글리프를 쓰지 않는다 — 아이콘이 사실과 어긋나면 안 된다.
 */
export const USAGE_CATEGORY_ICON: Record<UsageCategory, string> = {
  // 고층 — 창이 여러 층
  APARTMENT:
    '<path d="M2 11V2.5h5.5V11H2Zm1.4-6.6h1.2V3.2H3.4v1.2Zm1.9 0h1.2V3.2H5.3v1.2Zm-1.9 2.3h1.2V5.5H3.4v1.2Zm1.9 0h1.2V5.5H5.3v1.2ZM8.3 11V5.6H11V11H8.3Zm1-3.3h.9v-1h-.9v1Z"/>',
  // 중층 — 창이 두 층
  OFFICETEL:
    '<path d="M2.5 11V1.8h7V11h-7Zm1.6-6.6h1.3V3.1H4.1v1.3Zm2.5 0h1.3V3.1H6.6v1.3Zm-2.5 2.6h1.3V5.7H4.1V7Zm2.5 0h1.3V5.7H6.6V7Zm-2.5 2.5h4V8.2h-4v1.3Z"/>',
  // 저층 다세대 — 낮고 넓게
  MULTI_HOUSE:
    '<path d="M1.5 11V4.6h4.2V11H1.5Zm4.9 0V6.4h4.1V11H6.4ZM2.8 7h1.5V5.6H2.8V7Zm0 2.6h1.5V8.2H2.8v1.4Zm4.9 0h1.5V8.2H7.7v1.4Z"/>',
  // 단독 — 맞배지붕
  DETACHED: '<path d="M6 1.7 1.4 5.3v.9h1V11h7.2V6.2h1v-.9L6 1.7Zm-1 8.1V7.1h2v2.7H5Z"/>',
  // 상가 — 어닝(천막)과 진열창
  RETAIL:
    '<path d="M1.6 2.4h8.8v1.5H1.6V2.4Zm.4 2.6h8v6h-3V7.6H5V11H2V5Zm4.6 1.1v1.6h2.1V6.1H6.6Z"/>',
  // 토지 — 필지 경계
  LAND: '<path d="M1.3 8.6 6 2.2l4.7 6.4H1.3Zm2.5-1.2h4.4L6 4.4 3.8 7.4Z"/><path d="M1.3 9.7h9.4v1.1H1.3V9.7Z"/>',
  // 그 밖 — 건물이라고 말하지 않는다
  OTHER: '<circle cx="6" cy="6" r="3"/>',
};
