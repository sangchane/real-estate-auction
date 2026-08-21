// 한 임차인의 여러 정보출처 행을 하나로 합친다.
//
// 매각물건명세서는 같은 사람을 정보출처마다 한 행씩 적는다(현황조사·권리신고·등기사항전부증명서).
// 행마다 채워지는 칸이 달라서 — 현황조사는 전입일은 있어도 보증금·확정일자가 비는 일이 잦고,
// 권리신고에는 보증금·확정일자·배당요구가 있다 — 한 행만 골라 판정하면 나머지 행에만 있는
// 값을 버리게 된다. 칸별로 값이 있는 쪽을 취한다.
//
// 값이 서로 다르면 정보출처 우선순위로 고른다: 권리신고(임차인 본인 신고) > 등기사항전부증명서
// (등기된 사실) > 현황조사(집행관이 문을 두드려 확인한 것이라 가장 불확실하다).

export interface NoticeTenantRowInput {
  tenantSeq: number;
  /**
   * 이 행의 신고인이 보증기관(주택도시보증공사 등)인지. 보증금 대위를 가려내는 데 쓴다
   * (notice-tenant-succession) — 같은 보증금을 원 임차인과 보증기관이 각각 신고해
   * 두 사람으로 세어지기 때문이다.
   *
   * **성명 자체는 받지 않는다.** 이 저장소는 권리분석 응답에 성명이 섞여 나갈 경로를 아예
   * 만들지 않기로 했다(findNoticeAnalysis 주석). 판정에 필요한 것은 "보증기관인가"뿐이라
   * SQL에서 그 불리언만 계산해 넘긴다.
   */
  isGuarantor: boolean;
  sourceKind: string | null;
  occupiedPart: string | null;
  /** 점유의 권원 원문 — 명도 판단의 사실 근거라 요약하지 않고 그대로 나른다 */
  possessionBasis: string | null;
  moveInDate: string | null;
  fixedDate: string | null;
  depositAmount: number | null;
  demandedDistribution: boolean | null;
  demandedDistributionDate: string | null;
}

export interface MergedNoticeTenant extends Omit<NoticeTenantRowInput, 'sourceKind'> {
  /** 이 임차인이 나온 정보출처들 — 어디서 온 값인지 화면이 밝힐 수 있게 남긴다 */
  sourceKinds: string[];
}

const SOURCE_PRIORITY: Record<string, number> = {
  권리신고: 3,
  등기사항전부증명서: 2,
  현황조사: 1,
};

function priorityOf(sourceKind: string | null): number {
  return sourceKind === null ? 0 : (SOURCE_PRIORITY[sourceKind] ?? 0);
}

export function mergeNoticeTenants(rows: readonly NoticeTenantRowInput[]): MergedNoticeTenant[] {
  const bySeq = new Map<number, { merged: MergedNoticeTenant; priorityOf: Map<string, number> }>();

  for (const row of rows) {
    const rowPriority = priorityOf(row.sourceKind);
    const entry = bySeq.get(row.tenantSeq);

    if (entry === undefined) {
      bySeq.set(row.tenantSeq, {
        merged: {
          tenantSeq: row.tenantSeq,
          sourceKinds: row.sourceKind === null ? [] : [row.sourceKind],
          isGuarantor: row.isGuarantor,
          occupiedPart: row.occupiedPart,
          possessionBasis: row.possessionBasis,
          moveInDate: row.moveInDate,
          fixedDate: row.fixedDate,
          depositAmount: row.depositAmount,
          demandedDistribution: row.demandedDistribution,
          demandedDistributionDate: row.demandedDistributionDate,
        },
        priorityOf: fieldPriorities(row, rowPriority),
      });
      continue;
    }

    if (row.sourceKind !== null && !entry.merged.sourceKinds.includes(row.sourceKind)) {
      entry.merged.sourceKinds.push(row.sourceKind);
    }
    for (const field of FIELDS) {
      const value = row[field];
      if (value === null) continue;
      const current = entry.merged[field];
      // 비어 있으면 채우고, 이미 값이 있으면 더 믿을 만한 출처일 때만 덮는다
      if (current === null || rowPriority > (entry.priorityOf.get(field) ?? 0)) {
        Object.assign(entry.merged, { [field]: value });
        entry.priorityOf.set(field, rowPriority);
      }
    }
  }

  return [...bySeq.values()]
    .map((entry) => entry.merged)
    .sort((a, b) => a.tenantSeq - b.tenantSeq);
}

const FIELDS = [
  'occupiedPart',
  'possessionBasis',
  'moveInDate',
  'fixedDate',
  'depositAmount',
  'demandedDistribution',
  'demandedDistributionDate',
] as const;

function fieldPriorities(row: NoticeTenantRowInput, rowPriority: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const field of FIELDS) {
    if (row[field] !== null) map.set(field, rowPriority);
  }
  return map;
}
