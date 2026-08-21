import { assumedTotalOf, computeAffordability, propertyKindOfUsage, type AffordabilityInputs } from './affordability';
import type { AnalyzedTenantDto } from './dto/notice-analysis.dto';

function tenant(overrides: Partial<AnalyzedTenantDto>): AnalyzedTenantDto {
  return {
    tenantSeq: 1,
    sourceKinds: ['권리신고'],
    occupiedPart: null,
    possessionBasis: null,
    moveInDate: '2024-01-01',
    fixedDate: null,
    depositAmount: 50_000_000,
    demandedDistribution: null,
    demandedDistributionDate: null,
    possessionRightDate: '2024-01-02',
    hasPriority: true,
    distributionDemandEffective: false,
    assumption: 'ASSUMED_FULL',
    assumedAmount: 50_000_000,
    ...overrides,
  };
}

function inputs(overrides: Partial<AffordabilityInputs>): AffordabilityInputs {
  return {
    appraisalAmount: 300_000_000,
    minimumSalePrice: 192_000_000,
    bulkSale: false,
    usageName: '다세대',
    tenants: [],
    comparableSales: { usage: '다세대', sampleCount: 40, rateP25: 60, rateMedian: 70, rateP75: 80 },
    customBidPrice: null,
    ...overrides,
  };
}

describe('propertyKindOfUsage', () => {
  it('주거 용도는 HOUSING, 오피스텔은 취득세 기준상 NON_HOUSING이다', () => {
    expect(propertyKindOfUsage('아파트')).toBe('HOUSING');
    expect(propertyKindOfUsage('오피스텔')).toBe('NON_HOUSING');
  });

  it('모르는 용도는 null — 두 체계를 아우르는 구간으로 계산된다', () => {
    expect(propertyKindOfUsage('기타')).toBeNull();
    expect(propertyKindOfUsage(null)).toBeNull();
  });
});

describe('assumedTotalOf', () => {
  it('확정 인수액을 합산하고, 금액 미상이 있으면 하한으로 표시한다', () => {
    const result = assumedTotalOf([
      tenant({ assumption: 'ASSUMED_FULL', assumedAmount: 50_000_000 }),
      tenant({ tenantSeq: 2, assumption: 'ASSUMED_AMOUNT_UNKNOWN', assumedAmount: null }),
    ]);

    expect(result).toEqual({ amount: 50_000_000, isLowerBound: true });
  });

  it('임차인이 없으면 0원이 사실이다 — 하한이 아니다', () => {
    expect(assumedTotalOf([])).toEqual({ amount: 0, isLowerBound: false });
  });
});

describe('computeAffordability — 시나리오 구성', () => {
  it('최저가 + 유사 낙찰가율 3분위 시나리오를 만든다', () => {
    const result = computeAffordability(inputs({}));

    expect(result.scenarios.map((s) => s.kind)).toEqual([
      'MINIMUM_PRICE',
      'COMPARABLE_P25',
      'COMPARABLE_MEDIAN',
      'COMPARABLE_P75',
    ]);
    // 중위 70% × 감정가 3억 = 2.1억 입찰 가정
    const median = result.scenarios.find((s) => s.kind === 'COMPARABLE_MEDIAN');
    expect(median?.bidPrice).toBe(210_000_000);
  });

  it('직접 입력 입찰가는 CUSTOM 시나리오로 추가된다', () => {
    const result = computeAffordability(inputs({ customBidPrice: 250_000_000 }));

    expect(result.scenarios.at(-1)).toMatchObject({ kind: 'CUSTOM', bidPrice: 250_000_000 });
  });

  it('일괄매각은 직접 입력 말고는 시나리오를 만들지 않는다 — 최저가가 묶음 전체 값이다 (§4-2)', () => {
    const result = computeAffordability(inputs({ bulkSale: true, customBidPrice: 100_000_000 }));

    expect(result.scenarios.map((s) => s.kind)).toEqual(['CUSTOM']);
  });

  it('유사 표본이 없으면 최저가 시나리오만 만든다', () => {
    const result = computeAffordability(
      inputs({ comparableSales: { usage: '다세대', sampleCount: 0, rateP25: null, rateMedian: null, rateP75: null } }),
    );

    expect(result.scenarios.map((s) => s.kind)).toEqual(['MINIMUM_PRICE']);
  });
});

describe('computeAffordability — 금액과 비율', () => {
  it('인수액이 확정 합계에 들어가고, 감정가 대비 %가 계산된다', () => {
    const result = computeAffordability(inputs({ tenants: [tenant({})] }));

    const minimum = result.scenarios.find((s) => s.kind === 'MINIMUM_PRICE');
    if (minimum === undefined) throw new Error('MINIMUM_PRICE 시나리오가 없다');
    // 확정 합계 = 최저가 1.92억 + 인수 0.5억
    expect(minimum.totalBurden).toBe(242_000_000);
    // 감정가 대비 % 구간 = totalWithExtras / 3억
    expect(minimum.appraisalRatio).toEqual({
      min: Math.round((minimum.totalWithExtras.min / 300_000_000) * 1000) / 10,
      max: Math.round((minimum.totalWithExtras.max / 300_000_000) * 1000) / 10,
    });
  });

  it('감정가가 없으면 비율은 null이다 — 0으로 나눠 지어내지 않는다', () => {
    const result = computeAffordability(inputs({ appraisalAmount: null, comparableSales: { usage: null, sampleCount: 0, rateP25: null, rateMedian: null, rateP75: null } }));

    const minimum = result.scenarios.find((s) => s.kind === 'MINIMUM_PRICE');
    expect(minimum?.appraisalRatio).toBeNull();
  });

  it('점유자가 없으면 명도 구간이 낮은 쪽, 인수 임차인이 있으면 손실 쪽이다', () => {
    const empty = computeAffordability(inputs({}));
    const withLoss = computeAffordability(inputs({ tenants: [tenant({})] }));

    const evictionOf = (r: typeof empty) =>
      r.scenarios[0]?.extras.find((e) => e.kind === 'EVICTION_COST')?.range;
    expect(evictionOf(empty)).toEqual({ min: 0, max: 1_500_000 });
    expect(evictionOf(withLoss)).toEqual({ min: 2_000_000, max: 7_000_000 });
  });

  it('대비 기준은 감정가다 — 시세 연동 전까지 화면이 이 사실을 밝혀야 한다', () => {
    expect(computeAffordability(inputs({})).referencePrice).toBe('APPRAISAL');
  });
});
