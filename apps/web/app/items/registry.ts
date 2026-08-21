// 등기부 상태 타입 — API 응답 계약을 화면 쪽에 고정한다.
//
// 열람 1건에 700원이 실제로 나가므로 화면에서 지켜야 할 것이 하나 있다:
// **보관본 조회(GET)와 발급(POST)을 절대 섞지 않는다.** 목록을 그리다가 무심코 발급하면
// 사용자 돈이 나간다. 그래서 상태와 발급이 다른 함수·다른 메서드로 나뉘어 있다.
export type RegistryStatus =
  /** 이미 받아 둔 등기부가 있다 — 추가 비용 없음 */
  | 'FETCHED'
  /** 아직 안 받았다. 받으려면 700원이 든다 */
  | 'NOT_FETCHED'
  /** 지금은 받을 수 없다 (설정 없음·주소를 못 읽음 등) */
  | 'UNAVAILABLE';

export type RegisteredRightType =
  | 'MORTGAGE'
  | 'SEIZURE'
  | 'PROVISIONAL_SEIZURE'
  | 'COLLATERAL_PROVISIONAL_REGISTRATION'
  | 'AUCTION_COMMENCEMENT'
  | 'LEASEHOLD'
  | 'SUPERFICIES'
  | 'EASEMENT'
  | 'PROVISIONAL_REGISTRATION'
  | 'PROVISIONAL_DISPOSITION';

export interface RegisteredRight {
  id: string;
  type: RegisteredRightType;
  receivedDate: string;
  amount?: number;
  isWholeBuilding?: boolean;
  demandedDistribution?: boolean;
}

export interface RegistryState {
  status: RegistryStatus;
  registeredRights: RegisteredRight[] | null;
  /** 열람한 시각 — 화면에 그대로 보여준다. 등기부는 계속 바뀌므로 최신이라고 말하지 않는다 */
  fetchedAt: string | null;
  /** 발급하면 무엇을 조회하게 되는지 — 돈을 쓰기 전에 눈으로 확인할 값이다 */
  lookupPreview: string | null;
  /** 받을 수 없다면 그 이유 */
  reason: string | null;
}
