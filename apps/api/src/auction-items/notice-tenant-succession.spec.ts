import { mergeSuccessions } from './notice-tenant-succession';
import type { MergedNoticeTenant } from './notice-tenant-merge';

function tenant(over: Partial<MergedNoticeTenant> & { tenantSeq: number }): MergedNoticeTenant {
  return {
    sourceKinds: ['권리신고'],
    isGuarantor: false,
    occupiedPart: null,
    moveInDate: null,
    fixedDate: null,
    depositAmount: null,
    demandedDistribution: null,
    demandedDistributionDate: null,
    ...over,
  } as MergedNoticeTenant;
}

describe('보증기관 대위 합치기', () => {
  it('같은 보증금·전입일을 가진 임차인과 보증기관을 한 채권으로 합친다', () => {
    // 실측 2025타경52417: 전순옥의 보증금을 주택도시보증공사가 대위했다
    const merged = mergeSuccessions([
      tenant({
        tenantSeq: 1,
        isGuarantor: false,
        sourceKinds: ['등기사항전부증명서'],
        depositAmount: 210_000_000,
        moveInDate: '2020-04-24',
        fixedDate: '2020-04-03',
      }),
      tenant({
        tenantSeq: 2,
        isGuarantor: true,
        depositAmount: 210_000_000,
        moveInDate: '2020-04-24',
        fixedDate: '2020-04-03',
        demandedDistribution: true,
      }),
    ]);

    expect(merged).toHaveLength(1);
    const [only] = merged;
    expect(only).toBeDefined();
    if (!only) return;
    expect(only.isGuarantor).toBe(true);
    expect(only.succeeded).toBe(true);
    expect(only.depositAmount).toBe(210_000_000);
    // 배당요구는 채권을 가진 보증기관이 한 것을 따른다
    expect(only.demandedDistribution).toBe(true);
    // 두 출처가 다 보존돼야 화면이 근거를 밝힐 수 있다
    expect(only.sourceKinds).toEqual(
      expect.arrayContaining(['등기사항전부증명서', '권리신고']),
    );
  });

  it('대항력 날짜는 원 임차인의 것을 쓴다 — 대위는 점유를 새로 시작한 것이 아니다', () => {
    const merged = mergeSuccessions([
      tenant({
        tenantSeq: 1,
        isGuarantor: false,
        depositAmount: 100_000_000,
        moveInDate: '2020-01-02',
        fixedDate: '2020-01-03',
      }),
      tenant({
        tenantSeq: 2,
        isGuarantor: true,
        depositAmount: 100_000_000,
        moveInDate: '2020-01-02',
        fixedDate: null,
        demandedDistribution: true,
      }),
    ]);

    const [only] = merged;
    if (!only) throw new Error('합쳐진 결과가 없다');
    expect(only.moveInDate).toBe('2020-01-02');
    expect(only.fixedDate).toBe('2020-01-03');
  });

  it('보증금이 다르면 합치지 않는다 — 보증기관은 한 물건에서 여러 채권을 대위할 수 있다', () => {
    const merged = mergeSuccessions([
      tenant({ tenantSeq: 1, isGuarantor: false, depositAmount: 100_000_000, moveInDate: '2020-01-02' }),
      tenant({ tenantSeq: 2, isGuarantor: true, depositAmount: 200_000_000, moveInDate: '2020-01-02' }),
    ]);

    expect(merged).toHaveLength(2);
  });

  it('전입일이 다르면 합치지 않는다', () => {
    const merged = mergeSuccessions([
      tenant({ tenantSeq: 1, isGuarantor: false, depositAmount: 100_000_000, moveInDate: '2020-01-02' }),
      tenant({ tenantSeq: 2, isGuarantor: true, depositAmount: 100_000_000, moveInDate: '2021-05-06' }),
    ]);

    expect(merged).toHaveLength(2);
  });

  it('둘 다 개인이면 합치지 않는다 — 다가구에서 보증금·전입일이 우연히 같을 수 있다', () => {
    // 이것이 과소 표시 위험이다. 진짜 세입자 둘을 합치면 인수액이 절반으로 줄어든다 (§4-27).
    const merged = mergeSuccessions([
      tenant({ tenantSeq: 1, isGuarantor: false, depositAmount: 50_000_000, moveInDate: '2020-01-02' }),
      tenant({ tenantSeq: 2, isGuarantor: false, depositAmount: 50_000_000, moveInDate: '2020-01-02' }),
    ]);

    expect(merged).toHaveLength(2);
  });

  it('보증기관 판정은 SQL이 하므로 isGuarantor=false면 합치지 않는다 (LH 전세임대가 이 경우다)', () => {
    const merged = mergeSuccessions([
      tenant({ tenantSeq: 1, isGuarantor: false, depositAmount: 80_000_000, moveInDate: '2019-03-04' }),
      tenant({ tenantSeq: 2, isGuarantor: false, depositAmount: 80_000_000, moveInDate: '2019-03-04' }),
    ]);

    expect(merged).toHaveLength(2);
  });

  it('보증기관이 셋 이상 섞여도 짝을 이룬 것만 합친다', () => {
    const merged = mergeSuccessions([
      tenant({ tenantSeq: 1, isGuarantor: false, depositAmount: 100_000_000, moveInDate: '2020-01-02' }),
      tenant({ tenantSeq: 2, isGuarantor: true, depositAmount: 100_000_000, moveInDate: '2020-01-02' }),
      tenant({ tenantSeq: 3, isGuarantor: false, depositAmount: 70_000_000, moveInDate: '2021-07-08' }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((t) => t.tenantSeq)).toEqual([1, 3]);
    const second = merged[1];
    if (!second) throw new Error('두 번째 결과가 없다');
    expect(second.succeeded).toBe(false);
  });

  it('대위가 없으면 입력을 그대로 둔다', () => {
    const input = [tenant({ tenantSeq: 1, isGuarantor: false, depositAmount: 1, moveInDate: '2020-01-02' })];

    const merged = mergeSuccessions(input);

    expect(merged).toHaveLength(1);
    const [kept] = merged;
    if (!kept) throw new Error('결과가 없다');
    expect(kept.succeeded).toBe(false);
  });
});
