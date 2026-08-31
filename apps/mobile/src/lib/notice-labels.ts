// 매각물건명세서 코드 → 화면 라벨. 수집기(court_parser.py)가 만드는 코드와 1:1로 맞춘다.
//
// apps/web/app/items/notice-labels.ts와 같은 내용이다 — format.ts와 같은 선례로 웹/앱 각각 둔다
// (@auction/shared를 RN에 새로 붙이면 Metro 해석 문제를 다시 겪는다). 한쪽만 고치면 다른 쪽이
// 코드 원문을 노출하므로, 코드가 늘면 **두 파일을 함께** 고쳐야 한다.
//
// 라벨은 법원이 공고한 사실을 옮긴 것이지 우리 판단이 아니다 — "안전/위험/추천" 같은 평가어를
// 쓰지 않는다(D-011).

import { assumedHeadline } from './notice-analysis';

export const ASSUMED_RIGHTS_LABEL: Record<string, string> = {
  NONE: '인수할 권리 없음',
  LEASEHOLD_REGISTRATION: '주택임차권등기',
  SUPERFICIES: '지상권',
  PROVISIONAL_REGISTRATION: '가등기',
  OTHER: '그 밖의 인수권리',
};

export const RISK_FLAG_LABEL: Record<string, string> = {
  HUG_PRIORITY_WAIVER: 'HUG 대항력포기 확약',
  LIEN_CLAIM: '유치권 신고',
  PREEMPTIVE_PURCHASE: '우선매수 신고',
  SENIOR_TAX: '선순위 조세',
  TITLE_LOSS_RISK: '소유권 상실 가능',
  RESALE: '재매각',
  LAND_SEPARATE_REGISTRATION: '토지 별도등기',
  UNAUTHORIZED_EXTENSION: '무단증축·미준공',
  SITE_RIGHT_UNREGISTERED: '대지권 미등기',
  WATER_LEAK: '누수',
};

/** null은 "명세서를 못 받았다"이지 "인수할 권리가 없다"가 아니다. 모르는 코드는 그대로 노출한다. */
export function assumedRightsLabel(kind: string | null): string | null {
  if (kind === null) return null;
  return ASSUMED_RIGHTS_LABEL[kind] ?? kind;
}

export function riskFlagLabels(flags: readonly string[]): string[] {
  return flags.map(flag => RISK_FLAG_LABEL[flag] ?? flag);
}

/** 법원이 콤마로 묶어 보내는 용도 원문에서 대표값만 남긴다 ("연립주택,다세대,빌라" → "연립주택"). */
export function shortUsageName(usageName: string | null): string | null {
  if (usageName === null) return null;
  const first = usageName.split(',')[0]?.trim();
  return first ? first : null;
}

/** 0명("조사했는데 없음")과 null("명세서 미확인")은 다르다. */
export function tenantLabel(tenantCount: number | null): string | null {
  // 사람 수를 세지 않는다 — HUG 보증보험에 들면 같은 세입자가 등기·권리신고 두 줄이 되어
  // "점유자 2명"이 된다 (웹 notice-labels.ts에 같은 설명이 있다)
  if (tenantCount === null) return null;
  return tenantCount === 0 ? '점유자 없음' : '점유자 있음';
}

/**
 * 명세서 기반 인수 판정 → 화면 라벨. 등기부 없이 나온 결과라 "금액 미상"이 정상 상태다.
 * 판단·권유가 아니라 상태를 그대로 옮긴 문구만 쓴다 (D-011).
 */
export const NOTICE_ASSUMPTION_LABEL: Record<string, string> = {
  NOT_ASSUMED: '인수 안 함',
  ASSUMED_FULL: '보증금 전액 인수',
  ASSUMED_AMOUNT_UNKNOWN: '금액 미확정',
  UNKNOWN: '판정 불가',
};

/** 그 판정이 왜 그렇게 나왔는지 — 사실만 적는다. */
export const NOTICE_ASSUMPTION_REASON: Record<string, string> = {
  // 웹 notice-labels.ts와 같은 문구다 — 같은 물건이 두 화면에서 다르게 읽히면 안 된다.
  // 용어(대항력·말소기준·배당요구)를 결과로 바꿔 쓴다.
  NOT_ASSUMED: '기준 날짜보다 늦게 전입해서, 보증금을 매수인이 떠안지 않아요',
  ASSUMED_FULL:
    '기준 날짜보다 먼저 전입했는데 배당요구를 하지 않았어요(또는 마감일을 넘겼어요). 그래서 보증금 전액이 매수인에게 넘어와요',
  ASSUMED_AMOUNT_UNKNOWN:
    '먼저 전입했고 배당요구도 했어요. 배당에서 못 돌려받는 만큼을 매수인이 내주는데, 그 금액은 등기부의 빚 목록이 있어야 계산돼요',
  UNKNOWN: '전입일이나 기준 날짜가 명세서에 없어 판정할 수 없어요',
};

/**
 * 매수인 부담 구분 — 등기부 없이도 권리 **종류**만으로 확정되는 것을 적는다.
 *
 * 근저당·저당권·압류·가압류·담보가등기·경매개시결정은 접수 시점이 말소기준보다 앞서든 뒤든
 * 매각으로 소멸한다(소제주의). `apps/api` right-classification.ts의 ALWAYS_EXTINGUISHED_ON_SALE와
 * 같은 규칙이라 두 곳이 갈라지면 안 된다. 용익물권 계열은 말소기준보다 앞서면 인수될 수 있다.
 *
 * 이 물건에 실제로 어떤 등기 권리가 있는지는 등기부(WP-04) 연동 전이라 알 수 없다 — 그래서
 * 권리 목록이 아니라 종류별 규칙만 보여준다. 법적 효과의 사실 서술이며 판단·권유가 아니다 (D-011).
 */
export type BurdenStatus = 'ASSUMED' | 'NOT_ASSUMED' | 'NEEDS_REVIEW';

export const BURDEN_STATUS_LABEL: Record<BurdenStatus, string> = {
  ASSUMED: '인수',
  NOT_ASSUMED: '인수 안 함',
  NEEDS_REVIEW: '확인 필요',
};

export interface RegisteredBurdenRule {
  subject: string;
  detail: string;
  status: BurdenStatus;
}

export const REGISTERED_BURDEN_RULES: readonly RegisteredBurdenRule[] = [
  {
    subject: '근저당·저당권, 압류·가압류, 담보가등기, 경매개시결정',
    detail:
      '매각으로 소멸해서 매수인이 인수하지 않아요. 경매개시 전에 설정됐거나 말소기준보다 앞서도 마찬가지예요.',
    status: 'NOT_ASSUMED',
  },
  {
    subject: '전세권·지상권·지역권, 등기된 임차권',
    detail:
      '말소기준보다 앞서면 매수인이 인수할 수 있어요. 법원이 명세서에 적은 내용은 아래 명세서 기재사항에 나와요.',
    status: 'NEEDS_REVIEW',
  },
];

/**
 * 이 구분이 "이 물건의 등기부를 봤다"는 뜻이 아니라는 고지 — 이게 없으면 등기 권리가 하나도
 * 없는 물건으로 읽힌다. 등기부 미연동 자체는 화면 최상단 고지에 이미 있어 여기서 반복하지 않는다.
 */
export const REGISTERED_BURDEN_NOTE =
  '이 구분은 권리 종류에 따른 규칙이에요 — 이 물건의 등기부를 확인한 결과가 아니에요. (규칙: RIGHT_CLASSIFICATION v1)';

/**
 * 목록·지도 카드용 인수 보증금 한 줄. 상세 화면 헤드라인(assumedHeadline)과 **같은 분기**를 써서
 * 목록과 상세가 다른 말을 하지 않게 한다.
 *
 * null 입력은 명세서를 못 받았다는 뜻이라 문구를 만들지 않는다(null 반환) — 호출부가
 * "매각물건명세서 미확인"으로 따로 표기한다. 금액 포맷은 플랫폼마다 달라 주입받는다.
 */
export function assumedDepositCardLabel(
  deposit: { amount: number; isLowerBound: boolean } | null | undefined,
  formatAmount: (won: number) => string,
): string | null {
  // == null 로 받는다 — 필드가 빠진 옛 API 응답에서 목록 화면이 통째로 죽으면 안 된다
  if (deposit == null) return null;
  const headline = assumedHeadline(deposit);
  if (headline.kind === 'NONE') return '보증금 인수 없음';
  if (headline.kind === 'UNCONFIRMED') return '금액 미확정';
  return `보증금 인수 ${formatAmount(headline.amount)}${
    headline.isLowerBound ? ' 이상' : ''
  }`;
}

export function noticeAssumptionLabel(assumption: string): string {
  return NOTICE_ASSUMPTION_LABEL[assumption] ?? assumption;
}

export function noticeAssumptionReason(assumption: string): string | null {
  return NOTICE_ASSUMPTION_REASON[assumption] ?? null;
}
