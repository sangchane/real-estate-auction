# 구현 지침 (모든 코딩 에이전트 공통)

이 파일은 이 저장소에서 코드를 작성하는 **모든 도구·에이전트**(Codex, Antigravity, Claude Opus/Sonnet 등)가 따라야 하는 구현 규칙이다.
루트 `CLAUDE.md`는 변경하지 않는다. 구현 규칙의 추가·수정은 이 파일에서만 한다.

작업 시작 전 반드시 읽을 것:
1. `NEXT.md`의 `NEXT-ACTION` 마커 블록 — 지금 할 일 (SessionStart 훅이 자동 주입)
2. 이 파일 전체
3. 할당된 작업 지시서 (`docs/work-orders/WP-NN-*.md`)
4. 작업 지시서가 참조하는 기획 문서 (`solution-planning/realestate-auction-platform/`)
5. 만지는 폴더의 `CLAUDE.md` (스코프 규칙 — 온디맨드)

## 구현 기준 (22개 — 절대 준수)

1. 기존 프로젝트 구조와 스타일을 최대한 유지할 것.
2. 서비스 레이어 중심으로 비즈니스 로직을 분리할 것.
3. Controller/API/Service/Repository/DTO 책임을 명확히 나눌 것.
4. 함수는 하나의 책임만 갖도록 작게 작성할 것.
5. 입력값 검증을 명확히 하고, 잘못된 값은 초기에 차단할 것.
6. 예외처리는 무분별한 try-catch가 아니라, 복구 가능/불가능한 예외를 구분할 것.
7. 로그는 요청 식별자, 업무 키, 처리 건수, 실패 원인을 추적할 수 있게 남길 것.
8. 민감정보, 토큰, 비밀번호, 개인정보는 코드/로그/응답에 노출하지 말 것.
9. DB 변경이 여러 단계라면 transaction과 rollback 기준을 명확히 할 것.
10. 중복 요청, 동시 실행, 재시도 시 데이터가 깨지지 않도록 할 것.
11. 단위 테스트를 작성하고 정상/실패/경계값 케이스를 포함할 것.
12. 기존 API, DB schema, 설정 파일, 외부 연동 포맷의 하위 호환성을 깨지 말 것.
13. 설정값은 하드코딩하지 말고 환경별 설정으로 분리할 것.
14. 불필요한 의존성, 과한 추상화, 사용하지 않는 기능을 추가하지 말 것.
15. 변경한 코드와 직접 관련된 부분만 수정하고, 불필요한 리팩토링은 하지 말 것.
16. 빌드/테스트/lint 기준으로 검증 가능하게 만들 것.
17. 필요한 경우 README 또는 운영 메모에 실행 방법, 설정값, 테스트 방법, 장애 확인 방법을 남길 것.
18. 구현 후 변경 파일, 핵심 변경점, 테스트 결과, 남은 리스크를 요약할 것.

### TypeScript 규칙 (19~22 — apps/api, apps/web, apps/mobile, packages/shared 적용)

19. 타입 안정성을 우선할 것. `strict: true` 기반으로 작성하고, `any` 사용을 피할 것. 타입을 알 수 없는 값은 `unknown`으로 받아 내로잉 후 사용하고, `as` 단언과 `!` 넌널 단언을 남용하지 말 것 (ESLint `@typescript-eslint/no-explicit-any`로 강제).
20. DTO/Request/Response/도메인 타입을 명확히 분리할 것. Request DTO를 Response나 도메인 엔티티로 재사용하지 말고, 계층 경계(Controller↔Service↔Repository)마다 명시적 매핑을 둘 것.
21. **컴파일 타임 타입과 런타임 입력 검증을 혼동하지 말 것.** TS 타입은 런타임을 보호하지 않는다. 외부에서 들어오는 모든 입력은 별도 validator로 런타임 검증 후 타입이 보장된 값만 내부로 전달할 것:
    - HTTP 요청: class-validator DTO + 전역 `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`
    - 외부 API 응답(CODEF, 공공데이터, 법원): 스키마 검증(zod) 후 사용 — 응답을 `as` 캐스팅으로 신뢰 금지
    - 환경 변수: 부팅 시점에 스키마 검증하고 실패하면 기동 중단 (런타임 중간에 undefined로 터지지 않게)
22. 폴더 구조는 기존 구조가 있으면 그대로 따르고, 없으면 스택 표준 구조(NestJS: `module/controller/service/repository/dto`, Next.js: App Router 관례)로 **최소 파일만** 생성할 것. 미래 대비용 빈 파일·미리 만든 추상화 금지 (규칙 14와 동일 원칙).

## 이 프로젝트 고유의 추가 제약 (도메인·법적 — 위반 시 사업 리스크)

- **판단 문구 금지**: 권리분석 관련 코드·문구에 "입찰 추천/안전/위험 물건" 등 판단·권유 표현을 넣지 않는다. 사실 서술과 규칙 ID만 출력한다 (변호사법 §109 — decision-log D-011).
- **개인정보**: 성명은 원문 그대로 저장한다 — 민감정보·고유식별정보가 아니고 법원이 공개한 정보다 (사용자 결정 2026-07-30, 마이그레이션 007). **우리가 덧씌우는 정규식 마스킹은 금지** — 실측에서 오탐·미탐 모두 심했다(006). 법원이 이미 가려서 발행한 값도 그대로 저장한다(그것도 원문이다). 가려야 할 원문은 저장 자체를 하지 않는 쪽으로 처리하며, 제3자 실명이 섞이는 자유서술이 그 경우다. 배당종결 사건은 성명·보관 원문을 지운다(보유기간 규칙, NF-03). 주민등록번호 필드는 어떤 스키마에도 만들지 않는다 (D-011a, A-08).
- **수집 예절**: courtauction.go.kr 수집기는 요청 간격 제한·백오프를 반드시 넣고, 차단 조치가 감지되면 우회하지 않고 중단·알림한다 (D-007).
- **사용자 대면 문구**: 해요체, 능동형, 긍정형, 전문용어 쉬운 설명 병기 (05-blueprint UX-03, 토스 UX 원칙 T-09~13).
- **프론트 디자인**: 시각 토큰·컴포넌트는 루트 `DESIGN-meta.md` + `docs/design/design-adaptation.md`(도메인 매핑·치환·제외 규칙)를 따른다. 스타일 값 하드코딩 금지 — 토큰 참조로만. 폰트는 Pretendard Variable (Optimistic VF 치환 — 라이선스·한글).

## 기술 스택 (확정 — decision-log D-004~D-010)

React Native 0.86 (앱) / Next.js 16 (웹) / NestJS 11 (API) / PostgreSQL 18 + PostGIS 3.6 / Python (수집 배치) / 네이버 NCP Maps + 카카오 로컬 (지도 어댑터 레이어 필수) / NCP (인프라)

## 검증 명령 (모든 WP 공통 최소 기준)

- TypeScript: `pnpm -r lint && pnpm -r test && pnpm -r build`
- Python(수집기): `ruff check . && pytest`
- 완료 보고는 규칙 18 형식을 따른다.

## 네비게이션 (무엇이 어디에)

- 다음 할 일(단일 출처): `NEXT.md` — 히스토리는 `WORKLOG.md` (항상 읽지 않음)
- 스코프 규칙(온디맨드): `apps/api` `apps/web` `apps/mobile` `tools/collector` `tools/backtest` 각 `CLAUDE.md`
- 시크릿: 값은 `.env`(커밋 금지), 키 목록은 `.env.example`
