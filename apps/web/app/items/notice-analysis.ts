// 매각물건명세서 기반 권리분석 응답 타입 (apps/api NoticeAnalysisDto와 1:1).
//
// 성명이 없는 것이 정상이다 — 법원이 공개한 제3자 개인정보라 API가 내려주지 않는다.
// 줄을 구분하는 값은 점유부분(호수)과 순번이다.

export type NoticeAssumption =
  | 'NOT_ASSUMED'
  | 'ASSUMED_FULL'
  | 'ASSUMED_AMOUNT_UNKNOWN'
  | 'UNKNOWN';

export interface AnalyzedTenant {
  tenantSeq: number;
  sourceKinds: string[];
  occupiedPart: string | null;
  /** 점유의 권원 원문 (예: "주거 임차인") — 명도 확인의 사실 근거다 */
  possessionBasis: string | null;
  moveInDate: string | null;
  fixedDate: string | null;
  depositAmount: number | null;
  demandedDistribution: boolean | null;
  demandedDistributionDate: string | null;
  possessionRightDate: string | null;
  hasPriority: boolean | null;
  distributionDemandEffective: boolean | null;
  assumption: NoticeAssumption;
  assumedAmount: number | null;
}

export interface NoticeAnalysis {
  documentDate: string | null;
  baselineRaw: string | null;
  baselineDate: string | null;
  distributionDemandDeadline: string | null;
  assumedRightsKind: string | null;
  riskFlags: string[];
  /**
   * 법원이 "조사된 임차내역 없음"으로 적었는지. null 이면 못 읽은 것이라 사실을 단정하지 않는다.
   * **"소유자가 산다"는 뜻이 아니다** — 공실이거나 조사가 안 됐을 수도 있다.
   */
  noTenantRecorded: boolean | null;
  tenants: AnalyzedTenant[];
  source: 'NOTICE_ONLY';
}

/** 인수가 확정된 임차인들의 보증금 합계. 금액 미상이 하나라도 있으면 이 값은 하한이다. */
export function assumedTotal(tenants: readonly AnalyzedTenant[]): {
  amount: number;
  isLowerBound: boolean;
} {
  let amount = 0;
  let isLowerBound = false;
  for (const tenant of tenants) {
    if (tenant.assumption === 'ASSUMED_FULL' && tenant.assumedAmount !== null) {
      amount += tenant.assumedAmount;
    } else if (tenant.assumption === 'ASSUMED_AMOUNT_UNKNOWN' || tenant.assumption === 'UNKNOWN') {
      isLowerBound = true;
    } else if (tenant.assumption === 'ASSUMED_FULL') {
      // 전액 인수인데 보증금을 못 읽은 경우 — 합계에 못 넣으니 하한이 된다
      isLowerBound = true;
    }
  }
  return { amount, isLowerBound };
}

export type AssumedHeadline =
  /** 확정된 인수 금액이 있다. isLowerBound면 이보다 클 수 있다 */
  | { kind: 'AMOUNT'; amount: number; isLowerBound: boolean }
  /** 확정된 금액이 하나도 없고 미확정 임차인이 있다 — 0원으로 보이면 "부담 없음"으로 읽힌다 */
  | { kind: 'UNCONFIRMED' }
  /** 임차인이 없거나 전원 인수 대상이 아니다 — 0원이 사실이다 */
  | { kind: 'NONE' };

/**
 * 큰 숫자 자리에 무엇을 쓸지 정한다.
 *
 * 0원과 "모른다"를 같은 화면으로 내면 안 된다 — 이 화면에서 가장 크게 보이는 값이라
 * 잘못 읽히면 나머지를 다 읽어도 회복되지 않는다.
 */
export function assumedHeadline(total: { amount: number; isLowerBound: boolean }): AssumedHeadline {
  if (total.amount > 0) {
    return { kind: 'AMOUNT', amount: total.amount, isLowerBound: total.isLowerBound };
  }
  return total.isLowerBound ? { kind: 'UNCONFIRMED' } : { kind: 'NONE' };
}
