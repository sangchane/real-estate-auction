# apps/web/ — 스코프 작업 지침

이 폴더의 파일을 다룰 때만 로드된다(온디맨드). 공통 행동규칙은 루트 `CLAUDE.md`,
프로젝트 표준·구현기준 22개는 `AGENTS.md`, 다음-할일은 `NEXT.md`를 따른다.

## 목표

Next.js 16 App Router 웹. 물건 목록·지도·상세, 로그인, 즐겨찾기, SEO, 내부 관리자 페이지(역채점).

## 소유 경로

`app/{admin,auth,components,favorites,items,login}`, `app/{layout,page,sitemap,robots,seo}.*`, `middleware.ts`
읽기 전용 입력: `packages/design-tokens`(시각 토큰), `apps/api`(HTTP 계약).

## 핵심 관례

- **`test` 스크립트가 테스트 파일을 열거한다.** 현재 `dist-test/app`, `app/items`, `app/items/map`,
  `app/login`, `app/auth` 만 실행된다. 다른 디렉토리(`app/admin`, `app/favorites`, `app/components` 등)에
  테스트를 새로 만들면 **조용히 실행되지 않는다** — `package.json`의 `test` 목록과
  `tsconfig.test.json`에 함께 등록할 것. jest가 아니라 `tsc` + `node --test` 조합이다.
- 시각 토큰·컴포넌트는 루트 `DESIGN-meta.md` + `docs/design/design-adaptation.md`를 따른다.
  스타일 값 하드코딩 금지 — 토큰 참조로만. 폰트는 Pretendard Variable.
- 지도는 어댑터 레이어를 거친다 (네이버 NCP Maps / 카카오 로컬 교체 가능해야 함 — D-010).
- 사용자 대면 문구: 해요체, 능동형, 긍정형, 전문용어는 쉬운 설명 병기. 판단·권유 표현 금지 (D-011).

## 검증

```
pnpm --filter @auction/web lint && pnpm --filter @auction/web test && pnpm --filter @auction/web build
```

## 로컬 확인 (실수 방지)

프로덕션 화면을 눈으로 볼 때는 **`pnpm --filter @auction/web serve`** 하나만 쓴다
(`next build && next start`).

`next start`가 떠 있는 채로 `next build`를 돌리면 안 된다. 서버는 옛 빌드의 청크 이름을
메모리에 들고 있는데 새 빌드가 그 파일을 지워, 브라우저에서 `ChunkLoadError`와 함께
"물건 정보를 불러오지 못했어요"가 뜬다. **코드 문제로 보이지만 서버 문제다** — 실제로 두 번
이 함정에 빠졌다(§4-32). 서버를 먼저 내리고, 빌드가 끝난 뒤에 띄운다.

지도(네이버 NCP)는 **포트 3000만 콘솔에 등록돼 있다.** 다른 포트로 띄우면 지도만 인증
실패(401)하고 나머지는 정상이라 원인을 찾기 어렵다.
