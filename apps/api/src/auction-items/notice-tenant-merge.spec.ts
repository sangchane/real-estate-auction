import { mergeNoticeTenants, type NoticeTenantRowInput } from './notice-tenant-merge';

function row(overrides: Partial<NoticeTenantRowInput> & Pick<NoticeTenantRowInput, 'tenantSeq'>): NoticeTenantRowInput {
  return {
    isGuarantor: false,
    sourceKind: '권리신고',
    occupiedPart: '202호',
    moveInDate: null,
    fixedDate: null,
    depositAmount: null,
    demandedDistribution: null,
    demandedDistributionDate: null,
    ...overrides,
  };
}

describe('mergeNoticeTenants', () => {
  it('정보출처마다 흩어진 값을 한 임차인으로 모은다', () => {
    // 현황조사에는 전입일만, 권리신고에는 보증금·확정일자·배당요구가 있는 실제 형태
    const merged = mergeNoticeTenants([
      row({ tenantSeq: 1, sourceKind: '현황조사', moveInDate: '2020-07-29' }),
      row({
        tenantSeq: 1,
        sourceKind: '권리신고',
        depositAmount: 50_000_000,
        fixedDate: '2023-12-20',
        demandedDistribution: true,
        demandedDistributionDate: '2024-10-25',
      }),
    ]);

    expect(merged).toEqual([
      {
        tenantSeq: 1,
        isGuarantor: false,
      sourceKinds: ['현황조사', '권리신고'],
        occupiedPart: '202호',
        moveInDate: '2020-07-29',
        fixedDate: '2023-12-20',
        depositAmount: 50_000_000,
        demandedDistribution: true,
        demandedDistributionDate: '2024-10-25',
      },
    ]);
  });

  it('값이 충돌하면 더 믿을 만한 정보출처를 쓴다 — 권리신고 > 등기 > 현황조사', () => {
    const merged = mergeNoticeTenants([
      row({ tenantSeq: 1, sourceKind: '현황조사', depositAmount: 40_000_000 }),
      row({ tenantSeq: 1, sourceKind: '권리신고', depositAmount: 50_000_000 }),
    ]);

    expect(merged[0]?.depositAmount).toBe(50_000_000);
  });

  it('행 순서가 바뀌어도 결과가 같다 — 낮은 우선순위가 나중에 와도 덮지 않는다', () => {
    const merged = mergeNoticeTenants([
      row({ tenantSeq: 1, sourceKind: '권리신고', depositAmount: 50_000_000 }),
      row({ tenantSeq: 1, sourceKind: '현황조사', depositAmount: 40_000_000 }),
    ]);

    expect(merged[0]?.depositAmount).toBe(50_000_000);
  });

  it('서로 다른 임차인은 합치지 않고 순번 순으로 정렬한다', () => {
    const merged = mergeNoticeTenants([
      row({ tenantSeq: 2, occupiedPart: '301호' }),
      row({ tenantSeq: 1, occupiedPart: '202호' }),
    ]);

    expect(merged.map((t) => t.tenantSeq)).toEqual([1, 2]);
    expect(merged.map((t) => t.occupiedPart)).toEqual(['202호', '301호']);
  });

  it('배당요구는 한 행에만 적혀도 그 임차인의 사실이다', () => {
    // 현황조사서에는 배당요구 칸이 비는 것이 정상 — 없다고 단정하면 "전액 인수"로 과장된다
    const merged = mergeNoticeTenants([
      row({ tenantSeq: 1, sourceKind: '현황조사', moveInDate: '2020-07-29' }),
      row({
        tenantSeq: 1,
        sourceKind: '권리신고',
        demandedDistribution: true,
        demandedDistributionDate: '2024-10-25',
      }),
    ]);

    expect(merged[0]?.demandedDistribution).toBe(true);
    expect(merged[0]?.demandedDistributionDate).toBe('2024-10-25');
  });

  it('빈 입력이면 빈 결과다', () => {
    expect(mergeNoticeTenants([])).toEqual([]);
  });
});
