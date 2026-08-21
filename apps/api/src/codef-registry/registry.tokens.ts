// 등기부 모듈의 DI 토큰과 설정 타입 — **모듈과 컨트롤러 어느 쪽도 import하지 않는 파일**이다.
//
// 전에는 토큰이 registry.module.ts에 있었는데, 컨트롤러가 모듈에서 토큰을 가져오고 모듈이
// 컨트롤러를 가져오면서 순환 참조가 생겼다. 순환이면 한쪽 심볼이 평가 시점에 undefined가 되고
// Nest는 "argument at index [0] is available?"로만 알려준다 — 기동해 보지 않으면 못 잡는다.
export const REGISTRY_CONFIG = Symbol('REGISTRY_CONFIG');
export const CODEF_REGISTRY_SERVICE = Symbol('CODEF_REGISTRY_SERVICE');

export interface RegistryLookupCredentialSet {
  phoneNo: string;
  ePrepayNo: string;
  ePrepayPass: string;
  publicKey: string;
}

export interface RegistryLookupConfig {
  /** 하나라도 빠지면 null — 열람을 시도조차 하지 않는다 */
  credentials: RegistryLookupCredentialSet | null;
  /** 데모(무료)를 보고 있는지. 운영으로 바꾸면 1건에 700원이 실제로 나간다 */
  isDemo: boolean;
  /** 비어 있는 환경변수 이름들 — 화면에 "설정이 없어요"만 띄우면 무엇을 채울지 알 수 없다 */
  missing: string[];
}
