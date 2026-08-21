import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assumedHeadline, assumedTotal, type AnalyzedTenant } from './notice-analysis';

function tenant(overrides: Partial<AnalyzedTenant> & Pick<AnalyzedTenant, 'tenantSeq'>): AnalyzedTenant {
  return {
    sourceKinds: ['권리신고'],
    occupiedPart: '202호',
    possessionBasis: '주거 임차인',
    moveInDate: '2020-07-29',
    fixedDate: '2023-12-20',
    depositAmount: 50_000_000,
    demandedDistribution: true,
    demandedDistributionDate: '2024-10-25',
    possessionRightDate: '2020-07-30',
    hasPriority: true,
    distributionDemandEffective: true,
    assumption: 'ASSUMED_AMOUNT_UNKNOWN',
    assumedAmount: null,
    ...overrides,
  };
}

test('전액 인수 보증금만 합산한다', () => {
  const result = assumedTotal([
    tenant({ tenantSeq: 1, assumption: 'ASSUMED_FULL', assumedAmount: 50_000_000 }),
    tenant({ tenantSeq: 2, assumption: 'NOT_ASSUMED', assumedAmount: 0 }),
  ]);

  assert.deepEqual(result, { amount: 50_000_000, isLowerBound: false });
});

test('금액 미상이 섞이면 합계는 하한이다 — 실제 인수액이 더 클 수 있다', () => {
  const result = assumedTotal([
    tenant({ tenantSeq: 1, assumption: 'ASSUMED_FULL', assumedAmount: 50_000_000 }),
    tenant({ tenantSeq: 2, assumption: 'ASSUMED_AMOUNT_UNKNOWN', assumedAmount: null }),
  ]);

  assert.deepEqual(result, { amount: 50_000_000, isLowerBound: true });
});

test('전액 인수인데 보증금을 못 읽었으면 합계에 넣지 않고 하한으로 표시한다', () => {
  const result = assumedTotal([
    tenant({ tenantSeq: 1, assumption: 'ASSUMED_FULL', assumedAmount: null }),
  ]);

  assert.deepEqual(result, { amount: 0, isLowerBound: true });
});

test('판정 불가도 하한을 만든다 — 인수 없음과 구분해야 한다', () => {
  const result = assumedTotal([tenant({ tenantSeq: 1, assumption: 'UNKNOWN', assumedAmount: null })]);
  assert.equal(result.isLowerBound, true);
});

test('확정 금액이 없고 미확정만 있으면 0원 대신 "확인 필요"를 크게 쓴다', () => {
  // 0원을 크게 띄우면 "인수 부담 없음"으로 읽힌다 — 화면에서 가장 큰 값이라 회복이 안 된다
  assert.deepEqual(assumedHeadline({ amount: 0, isLowerBound: true }), { kind: 'UNCONFIRMED' });
});

test('전원 인수 대상이 아니면 0원이 사실이다', () => {
  assert.deepEqual(assumedHeadline({ amount: 0, isLowerBound: false }), { kind: 'NONE' });
});

test('확정 금액이 있으면 금액을 쓰고 하한 여부를 함께 넘긴다', () => {
  assert.deepEqual(assumedHeadline({ amount: 50_000_000, isLowerBound: true }), {
    kind: 'AMOUNT',
    amount: 50_000_000,
    isLowerBound: true,
  });
});
