// 등기부 발급 호출(브라우저 전용) — **이 함수만 돈을 쓴다.**
//
// 상태 조회(`fetchRegistryState`)와 일부러 파일을 나눴다. 한 파일에 두면 목록·프리페치
// 코드가 실수로 발급 쪽을 부를 여지가 생기는데, 그 실수의 대가가 700원이다.
import type { ItemKey } from './item-id';
import type { RegistryState } from './registry';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

/** 등기부를 실제로 발급한다 — 사용자가 확인 버튼을 누른 뒤에만 호출할 것. */
export async function fetchRegistryOnDemand(key: ItemKey): Promise<RegistryState> {
  const url = `${API_BASE_URL}/auction-items/${encodeURIComponent(key.courtOfficeCode)}/${encodeURIComponent(key.caseNo)}/${encodeURIComponent(key.itemNo)}/registry`;
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) {
    // API가 돌려준 한국어 사유를 그대로 보여준다 — "주소가 3건 검색돼서 못 골랐어요" 같은
    // 문장은 사용자가 다음에 무엇을 할지 정하는 데 필요한 정보다.
    const body: unknown = await response.json().catch(() => null);
    const message =
      typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `등기부를 받지 못했어요 (${response.status})`;
    throw new Error(message);
  }
  return (await response.json()) as RegistryState;
}
