// 보증기관이 대위한 임차보증금을 한 채권으로 합친다 — 같은 돈을 두 사람으로 세지 않기 위해서.
//
// 왜 필요한가: 전세보증금 반환보증에 가입한 임차인이 보증사고를 당하면 보증기관(주택도시보증공사
// 등)이 먼저 지급하고 임차인의 보증금반환채권을 대위한다(주택임대차보호법 §3-2, 주택도시기금법).
// 매각물건명세서는 그 사실을 **두 행**으로 적는다 — 등기사항전부증명서에는 원 임차인이,
// 권리신고에는 대위한 보증기관이 나온다.
//
//   전순옥                   | 등기사항전부증명서 | 2.1억 | 전입 2020-04-24
//   주택도시보증공사(전순옥) | 권리신고          | 2.1억 | 전입 2020-04-24
//
// 문서가 그렇게 적는 것이 맞고 파서 문제가 아니다. 문제는 **한 채권을 두 사람으로 세는 것**이다.
// 실측(2026-08-21): 같은 (보증금, 전입일)이 둘로 갈린 그룹 1,578건 중 1,082건이 이 형태다.
//
// 피해가 두 가지다.
//   - 금액이 실제로 두 배가 되는 경우 55건 (양쪽 다 배당요구를 한 것으로 읽힘)
//   - 없는 임차인 때문에 "N억 **이상**"이 붙는 경우 1,506건 — "더 있을 수 있다"는 뜻인데
//     그 근거가 존재하지 않는다. 사용자가 실제보다 위험하게 읽는다.
import type { MergedNoticeTenant } from './notice-tenant-merge';

/**
 * 두 행이 같은 보증금 채권인지. **셋이 모두 같아야** 한다.
 *
 * 보증금과 전입일이 같아도 다가구에서는 우연히 겹칠 수 있어(§4-27이 기록한 과소 표시 위험)
 * "한쪽이 보증기관"이라는 조건을 반드시 함께 본다. 보증기관은 한 물건에 여러 채권을
 * 대위할 수 있으므로 보증기관만으로는 부족하고, 금액·전입일이 같아야 같은 채권이다.
 */
function isSameClaim(a: MergedNoticeTenant, b: MergedNoticeTenant): boolean {
  if (a.depositAmount === null || a.depositAmount !== b.depositAmount) return false;
  if (a.moveInDate === null || a.moveInDate !== b.moveInDate) return false;
  return a.isGuarantor !== b.isGuarantor;
}

/**
 * 대위 관계인 행들을 하나로 합친다. 합쳐진 결과는 **보증기관 쪽 정보를 우선**한다 —
 * 배당요구를 실제로 한 것은 채권을 가진 보증기관이기 때문이다.
 *
 * 대위 여부는 `succeeded`로 남긴다 — 화면이 "보증기관이 대위한 보증금"이라는 사실을 밝힐 수
 * 있어야 한다(판단이 아니라 사실 서술 — D-011). 성명은 받지 않으므로 "누구의"는 말하지 않는다.
 */
export function mergeSuccessions(tenants: MergedNoticeTenant[]): SuccessionMergedTenant[] {
  const merged: SuccessionMergedTenant[] = [];
  const taken = new Set<number>();

  for (const tenant of tenants) {
    if (taken.has(tenant.tenantSeq)) continue;

    const partner = tenants.find(
      (candidate) =>
        candidate.tenantSeq !== tenant.tenantSeq &&
        !taken.has(candidate.tenantSeq) &&
        isSameClaim(tenant, candidate),
    );

    if (partner === undefined) {
      merged.push({ ...tenant, succeeded: false });
      continue;
    }

    taken.add(tenant.tenantSeq);
    taken.add(partner.tenantSeq);

    const [guarantor, original] = tenant.isGuarantor ? [tenant, partner] : [partner, tenant];

    merged.push({
      ...guarantor,
      // 순번은 둘 중 앞선 것을 쓴다 — 화면의 표시 순서가 문서 순서와 어긋나지 않게
      tenantSeq: Math.min(tenant.tenantSeq, partner.tenantSeq),
      sourceKinds: [...new Set([...guarantor.sourceKinds, ...original.sourceKinds])],
      // 대항력 판단에 쓰이는 날짜는 **원 임차인의 것**이다. 대위는 채권을 넘겨받은 것이지
      // 점유를 새로 시작한 것이 아니라, 전입일·확정일자가 새로 생기지 않는다.
      moveInDate: original.moveInDate ?? guarantor.moveInDate,
      fixedDate: original.fixedDate ?? guarantor.fixedDate,
      // 배당요구는 채권자인 보증기관이 한 것을 따르되, 보증기관 쪽이 비면 원 임차인 값을 쓴다
      demandedDistribution: guarantor.demandedDistribution ?? original.demandedDistribution,
      demandedDistributionDate:
        guarantor.demandedDistributionDate ?? original.demandedDistributionDate,
      // 원 임차인 쪽 출처만 남긴다 — 성명은 받지도 않으므로 "누구의" 는 밝힐 수 없다.
      // 화면은 "보증기관이 대위한 보증금"이라는 사실까지만 말한다.
      succeeded: true,
    });
  }

  return merged;
}

export interface SuccessionMergedTenant extends MergedNoticeTenant {
  /** 보증기관이 원 임차인의 보증금을 대위한 건인지. 화면이 그 사실을 밝히는 데 쓴다 */
  succeeded: boolean;
}
