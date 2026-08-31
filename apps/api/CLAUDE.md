# apps/api/ — 스코프 작업 지침

이 폴더의 파일을 다룰 때만 로드된다(온디맨드). 공통 행동규칙은 루트 `CLAUDE.md`,
프로젝트 표준·구현기준 22개는 `AGENTS.md`, 다음-할일은 `NEXT.md`를 따른다.

## 목표

NestJS 11 API 서버. 물건 조회·권리분석·즐겨찾기·인증·알림·역채점 조회를 제공한다.

## 소유 경로

`src/{auction-items,auth,backtest,codef-registry,config,favorites,health,notifications,rights-analysis,zones}`
모듈마다 `controller / service / repository / dto`(+ 필요 시 `domain`)로 나눈다.
읽기 전용 입력: `packages/shared`(공용 타입), `tools/collector`가 채우는 DB 스키마.

## 핵심 관례

- 계층 경계마다 명시적 매핑. Request DTO를 Response·도메인 엔티티로 재사용하지 않는다 (기준 20).
- 런타임 검증은 타입과 별개다 (기준 21): HTTP는 class-validator DTO + 전역
  `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`, 외부 API 응답(CODEF·공공데이터·법원)은
  zod 스키마 검증 후 사용 — `as` 캐스팅으로 신뢰 금지, 환경변수는 부팅 시 검증하고 실패하면 기동 중단.
- **권리분석 응답에 판단·권유 표현 금지.** 사실 서술과 규칙 ID만 (변호사법 §109 — D-011).
- 소유자명 등 개인정보는 전용 테이블에만. 주민등록번호 필드는 만들지 않는다 (D-011a).

## 검증

```
pnpm --filter @auction/api lint && pnpm --filter @auction/api test && pnpm --filter @auction/api build
```
