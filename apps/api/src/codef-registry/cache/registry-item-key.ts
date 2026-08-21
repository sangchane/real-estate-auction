// 등기부 캐시 키 — **물건 단위**다. 사건 단위로 잡으면 안 되는 이유가 실측으로 확인됐다.
//
// 한 사건에 물건이 여럿인 경우가 3,083건 중 361건(12%)이고, 그 물건들은 주소가 다른 별개
// 부동산이라 등기부도 따로다(예: 2024타경64502 — 1층 10호 / 5층 50호). 사건 키로 캐시하면
// 2번 물건 화면에 1번 물건의 등기부가 붙어 권리분석이 조용히 틀린다.
export interface ItemKey {
  courtOfficeCode: string;
  caseNo: string;
  itemNo: string;
}

export function registryCacheKey(key: ItemKey): string {
  return `${key.courtOfficeCode}:${key.caseNo}:${key.itemNo}`;
}
