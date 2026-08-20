# 테스트 설계 — 정비구역·모아타운·노후도 지도 레이어

## 원칙

- 수용 기준(SC)·P0/P1 FR 전부가 최소 1개 시나리오를 갖는다(누락 0 게이트). 각 시나리오는 구현 전
  작성 시 반드시 실패해야 한다(TDD 게이트).
- 피라미드: unit 다수 → integration(도커 PostGIS 필요 표기) → contract(EP-1~3) → E2E 최소.
- 러너 준수: collector=pytest, api=기존 spec 러너, web=`tsc -p tsconfig.test.json` + `node --test`.
- **web 테스트 규칙 (08 M-5 반영 — 하네스를 바꾸지 않는다)**
  - **컴포넌트를 렌더하는 테스트는 만들지 않는다.** 실측: `apps/web/tsconfig.test.json`은
    `tsconfig.base.json`만 extends해 `jsx` 옵션도 `lib: dom`도 없고, devDependencies에
    testing-library·jsdom이 없으며, 기존 14개 테스트가 전부 순수 함수 테스트다(렌더 선례 0건).
    등록만 하면 컴파일 에러로 전부 실패한다.
  - 대신 검증 대상을 **순수 함수 3개**로 뽑는다: `zone-copy.ts`(문구 상수) ·
    `zone-style.ts`(kind·stageBucket → 스타일 객체) · `zone-geometry.ts`(GeoJSON 링 → LatLng 배열).
    JSX·DOM 동작은 E2E(수동 Playwright) 몫이다.
  - **등록**: `tsconfig.test.json`의 `include`는 명시 allowlist이므로 **소스·테스트 6개 항목**을
    추가한다. `package.json`의 test 글롭은 손대지 않아도 된다 — 세 파일이 `app/items/map/` 아래라
    기존 `dist-test/app/items/map/*.test.js`에 자동 포함된다(실측).
  - **SC-009 판정은 "등록 + 실행 + 통과"** 다. 등록만으로는 아무것도 보장하지 않는다.
- 외부 원천(브이월드 SHP·서울 열린데이터광장 API·표제부 원천·카카오 로컬)은 테스트에서 **절대
  실호출하지 않는다** — 고정 픽스처 파일(미니 SHP·JSON·CSV)로 대체(D-007 예절은 코드 경로
  검증으로만). 서울 API의 `sample` 키도 쓰지 않는다(5행 제한이라 재현성이 없고 외부 의존이 생긴다).

## 수용 기준 → 시나리오 변환표

| ID | Gherkin 시나리오 | 레이어 | 데이터/목킹 |
|---|---|---|---|
| TS-01 (SC-001, FR-001) | Given 피처 5개 미니 SHP(EPSG:5186)가 드롭 폴더에 있음 When `shp_importer(VWORLD_ZONE)` 실행 Then redevelopment_zone 5행 upsert + sync_run.counts의 원천=적재=5 (불일치 0) | integration(pytest, 도커 DB) | 픽스처 SHP |
| TS-02 (FR-001) | Given 동일 SHP 2회 연속 실행 When 완료 Then 행 수·geom·updated 값 불변 (멱등, SC-006) | integration | 동일 픽스처 |
| TS-03 (FR-001) | Given 이전 적재에 있던 구역이 새 SHP에 없음 When 실행 Then 해당 행 retired_at 설정·삭제 없음 (엣지 B-5) | integration | 픽스처 2종 |
| TS-03b (FR-001, 08 m-03) | Given retired_at이 설정된 구역이 새 SHP에 **다시 있음** When 실행 Then 그 행의 retired_at이 **NULL로 해제**되고 지도 기본 표시에 복귀 (07 오염 복구 절차가 성립하려면 필수) | integration | 픽스처 2종 역순 |
| TS-04 (FR-001) | Given 건수 급변(전회 100 → 이번 50) When 실행 Then 적재 보류·status=FAILED·알림 로그 (위협: 가짜/불량 원천) | unit(임계 판정 함수) + integration | 카운트 주입 |
| TS-05 (FR-001) | Given 드롭 폴더가 비어 있음 When 실행 Then **자동 다운로드를 시도하지 않고**(외부 HTTP 호출 스파이 0) 스킵·알림·기존 데이터 유지 | unit | 파일시스템 목킹 |
| TS-06 (SC-001, FR-001) | Given 자기교차 등 invalid 폴리곤 1건 포함 When 적재 Then ST_MakeValid 후 적재되고 보정 건수가 로그에 남는다 (조용히 버리기 금지) | integration | 불량 지오메트리 픽스처 |
| TS-07 (FR-002) | Given 구역 폴리곤 안 물건 1·경계선 위 물건 1·밖 물건 1 When recompute Then 안·경계선=조인 행 생성, 밖=없음 (엣지 A-3, ST_Intersects 기준) | integration | WKT 수작업 픽스처 |
| TS-08 (FR-002) | Given 물건이 두 구역에 겹침 When recompute Then auction_item_zone 2행 (엣지 A-1) | integration | 겹침 폴리곤 |
| TS-09 (FR-002) | Given geom NULL 물건 When recompute Then 조인 대상 제외·에러 없음 (엣지 A-2) | integration | NULL 물건 |
| TS-10 (FR-002) | Given recompute 2회 연속 Then 행 수 동일·computed_at만 갱신 (SC-006) | integration | — |
| TS-11 (FR-003) | Given 정규화 케이스 표: "신길 제10구역"→"신길10", "○○(가칭)구역"→"○○", "△△주택재개발정비사업"→"△△", 공백·중점 혼재, 빈 결과 문자열 When normalize_zone_name Then 기대값 일치(표 기반 파라미터라이즈) | unit(pytest) | 케이스 표 |
| TS-12 (SC-002, FR-003) | Given 자치구 내 정규화 키 일치 1:1 When 매칭 Then AUTO 매칭·current_stage 갱신 | integration | JSON 픽스처 |
| TS-13 (SC-002, FR-003) | Given 동일 키 후보 2건 When 매칭 Then 매칭 없음·stage NULL·stage_match_report에 후보 2건 (엣지 B-1, 허위 단계 0) | integration | 중복 이름 픽스처 |
| TS-14 (FR-003) | Given zone_alias 수동 별칭 존재 When 동기화 재실행 Then MANUAL 매칭 유지·별칭 미변경 (엣지 B-3) | integration | 별칭 사전 삽입 |
| TS-15 (FR-003) | Given 필수 필드(`DISTRICT`·`ZONE_NM`·`BIZ_TYPE`·`BIZ_STAGE`) 누락 응답, 그리고 `RESULT.CODE != "INFO-000"` 응답 When validate_schema Then 각각 전체 롤백·기존 단계 유지·FAILED 기록 (엣지 B-2, 2케이스) | integration | 결손 JSON |
| TS-15b (FR-003, 엣지 B-6) | Given `BIZ_STAGE`가 단계 사전에 없는 새 값("정비구역해제" 등) When 매칭 Then 그 구역은 stage 저장 안 함·stageBucket=미확인·`stage_match_report`에 원문 기록. **가까운 버킷으로 추정 배정 0건** | integration | 미지 값 픽스처 |
| TS-16 (SC-006, FR-003) | Given 같은 단계 데이터로 2회 실행 Then zone_stage_history 행 수 불변 (엣지 B-4, UNIQUE 제약) | integration | — |
| TS-17 (FR-003) | Given 단계가 실제로 변경된 응답 When 실행 Then history에 1행 append + current_stage 갱신 | integration | 2단계 픽스처 |
| TS-18 (FR-004) | Given 서울 시청 일대 bbox·zoom 12 When EP-1 호출 Then FeatureCollection·피처 상한 이하·단순화 적용·미매칭 구역 stage=null | contract(api spec) | 시드 DB 또는 리포지토리 목킹 |
| TS-19 (FR-004) | Given bbox 결측/min·max 역전/면적 상한 초과/kinds 오타/zoom 범위 밖 When EP-1 Then 각각 400 (5케이스 파라미터라이즈) | contract | — |
| TS-20 (SC-003, FR-004) | Given 서울 전역 bbox·zoom 12 실데이터 When 계측 스크립트 Then 응답 ≤512KB·로컬 p95 ≤500ms | 성능(수동 스크립트, CI 밖) | 실적재 DB |
| TS-21 (FR-005, DA-10) | Given DA-10 배정표의 7개 (zoneKind, stageBucket) 조합 When `zoneStyle()` 호출 Then 반환 객체가 표와 정확히 일치 — `strokeColor`·`fillColor`는 `colors.slate`와 **동일 참조값**, `strokeStyle`은 표의 리터럴, `fillOpacity`는 표의 수치. 사전에 없는 stageBucket을 넣으면 **미확인 스타일**(dot·0.05)이 나온다 | unit(web `node --test`) | **순수 함수 — SDK 스텁 불필요** |
| TS-21b (FR-005) | Given MultiPolygon(외곽 링 + 내부 구멍) GeoJSON 픽스처 When `ringsToLatLngs()` Then `[lng,lat]` → `naver.maps.LatLng(lat,lng)` 순서 뒤집힘 없이 링 구조 보존. 빈 배열·좌표 3개 미만 링은 예외 없이 스킵 | unit(web) | 좌표 픽스처 |
| TS-22 (FR-005) | Given `zoneStyle`·`ringsToLatLngs`·`ZONE_COPY` 세 모듈 When 정적 임포트 그래프 검사 Then **`naver.maps` 전역과 CSS 모듈을 임포트하지 않는다**(순수 유지 — 이게 깨지면 테스트가 컴파일 불가로 되돌아간다). 기존 마커 로직(`cluster.ts`·`usage-category.ts`)도 임포트하지 않는다 | unit(web) | 소스 텍스트 스캔 |
| TS-23 (SC-004, FR-005·006) | Given `ZONE_COPY`가 export한 문구 상수 전체 When 금칙어 13개 배열 검사 — `['추천','안전','위험','유망','유리','기회','수익','투자하','괜찮','좋은','패스','검토 대상','권장']` Then 0건. 추가로 **"제39조" 문자열이 링크 이외의 문장에 없음**(08 m-19: 조문 효과 설명 금지는 금칙어로 안 잡힌다) | unit(web) | 문구 상수 모듈 |
| TS-24 (SC-005) | Given 신규 CSS 모듈·TSX 파일 목록 When hex 리터럴 스캔(대소문자 무시, #[0-9a-fA-F]{3,8}) Then 0건 — 토큰 참조(CSS var 또는 design-tokens 임포트)만 | unit(web) | 파일 글롭 |
| TS-25 (FR-006, EP-3) | Given 두 구역 겹침 물건 When `GET /auction-items/:c/:n/:i/zone-facts` Then zoneFacts 2건 모두 + 각각 stage/stageBucket 또는 null | contract | 시드 |
| TS-26 (FR-006) | Given geom NULL 물건 When 같은 엔드포인트 Then zoneFacts=null (빈 배열 아님 — "밖" 오독 방지), dongBuildingAge=null | contract | 시드 |
| TS-26b (FR-006, 08 M-4·규칙 12) | Given 기존 상세 `GET /auction-items/:c/:n/:i` When 조회 Then **응답 필드가 이번 변경 전과 완전히 동일**(스냅샷 비교) — zone 관련 필드가 새로 섞여 들어가지 않았음을 못 박는다 | contract | 스냅샷 |
| TS-27 (FR-006) | Given zoneFacts 픽스처 4종(stage 있음 / stage null인 REDEV / MOATOWN_CANDIDATE / zoneFacts=null) When **문장 조립 순수 함수** `zoneFactSentences(facts)` Then 각각 기대 문장 배열이 나온다 — stage null이면 "추진 단계 정보를 아직 연결하지 못했어요", MOATOWN_CANDIDATE면 "경계가 아직 고시 전이에요"(문구 상수 1개 고정 — 08 m-12), zoneFacts=null이면 **빈 배열**(섹션 자체를 그리지 않는다, "구역 밖"이라고 말하지 않기). 컴포넌트는 이 배열을 텍스트 노드로 뿌리기만 한다 | unit(web) | 픽스처 props |
| TS-28 (FR-009) | Given 표제부 미니 픽스처(실포맷 확정 후 작성 — PRD 가정 5, 서울 3개동(SC-008과 표본 일치), 승인일 결측 1건 포함) When 집계 Then 동별 분모=결측 제외, over20/over30 카운트 기대 일치 (엣지 C-3, SC-008 표본 방식) | unit(pytest) | CSV 픽스처 |
| TS-29 (FR-009) | Given 건물 0동인 동 When 집계·조회 Then 카운트 0 저장, EP-3 dongBuildingAge=null (엣지 C-2, 0% 표기 금지) | integration+contract | — |
| TS-30 (FR-009) | Given 같은 base_ym 재실행 Then PK(bjd_code, base_ym) upsert로 행 수 불변 (SC-006) | integration | — |
| TS-31 (FR-008) | Given 시드 CSV의 대상지 1건 지오코딩 실패 When 적재 Then rep_point NULL·지도 미표시·실패 로그 (엣지 C-1) | unit(pytest) | 카카오 API 목킹 |
| TS-32 (FR-012, EP-2) | Given 구역 안 물건·밖 물건 When bbox 핀 조회 Then zoneKinds가 각각 채워짐/[] — 기존 필드는 전부 불변(스냅샷 비교) | contract | 시드 |
| TS-33 (FR-011) | Given 미매칭 3건 발생 When stage_sync 종료 Then stage_match_report 3행 + 로그에 미매칭 카운트 | integration | 픽스처 |
| TS-34 (SC-007·009) | Given 전체 검증 명령 When 실행 Then `pnpm -r lint && pnpm -r test && pnpm -r build` + `ruff check . && pytest` 통과, **그리고** `pnpm --filter web test` 출력에 `zone-copy.test.js`·`zone-style.test.js`·`zone-geometry.test.js` 세 파일명이 모두 보이며 `fail 0`. 기존 map 테스트 무회귀 | 파이프라인 | — |
| TS-35 (FR-002) | Given run_daily로 구역 안 좌표의 신규 물건 1건 적재 When 일일 증분 recompute_incremental Then auction_item_zone에 즉시 행 생성(월간 배치 대기 없음 — GATE 반영) | integration | 시드 |
| TS-36 (**FR-017**) | Given 법정동 미니 SHP 3개동 When `shp_importer(VWORLD_DONG)` Then `bjd_dong` 3행 적재 + **기존 `redevelopment_zone` 행 무접촉**(소스 격리 확인 — 같은 임포터를 공유하므로 이 격리가 깨지기 쉽다) | integration | 픽스처 SHP |
| TS-37 (FR-010) | Given dongBuildingAge 정상값·null 두 가지 When **순수 함수** `buildingAgeSentence(dong)` Then 정상값은 20/30년 두 비율 + 기준연월 + 조작적 정의를 담은 문장, null이면 **빈 문자열**(0%로 쓰지 않기). 금칙어 0건 | unit(web) | 픽스처 props |
| TS-38 (FR-008, EP-1) | Given MOATOWN_CANDIDATE Point 피처(boundaryStatus=PRE_NOTICE, **stage 키 자체가 없음**) When 렌더 분기 결정 순수 함수 `featureRenderKind(feature)` Then `'MARKER'`를 반환하고(폴리곤 아님), `zoneFactSentences`가 stage 키 부재를 예외 없이 처리하며 "경계가 아직 고시 전이에요" 문구를 낸다 | unit(web) | 픽스처 |
| TS-39 (FR-004·005) | Given 피처 상한 초과 상황 When EP-1 조회·웹 렌더 Then truncated=true 반환 + "구역이 많아 일부만 보여요" 안내 표시(조용한 누락 금지) | contract + unit(web) | 상한 축소 주입 |
| TS-40 (FR-003) | Given 서로 다른 자치구에 동일 원문 구역명 2건과 각각의 별칭(gu 포함) When 동기화 Then 각자 자기 자치구 구역에만 매칭(교차 오귀속 0 — GATE 반영) | integration | 동명 픽스처 |
| TS-41 (FR-017, FR-010, 08 M-1) | Given 동 폴리곤 안 물건 1 · **경계선 위 물건 1** · geom NULL 물건 1 When `recompute_dong` Then 안=`auction_item_dong` 1행, 경계선 위·NULL=행 없음(`ST_Contains` 기준 — 물건×구역의 `ST_Intersects`와 기준이 다르다는 점을 이 테스트가 고정한다) + 미배정 건수가 로그에 남는다 | integration | WKT 수작업 픽스처 |
| TS-42 (FR-017) | Given `recompute_dong` 2회 연속 When 완료 Then 행 수 동일·computed_at만 갱신 (SC-006 멱등) | integration | — |

## 계약 테스트 (A5 표 기준)

- EP-1: 응답 스키마(FeatureCollection·properties 키 전수 — `stageBucket` 포함)·truncated 플래그·
  kinds 필터 동작·좌표 소수점 6자리·400 계열.
- EP-2: **기존 필드 스냅샷 불변**(하위 호환 회귀 — 규칙 12) + 신규 `zoneKinds` 형태.
- EP-3(신규 서브리소스): 응답 스키마 + 404. **기존 상세 리소스의 스냅샷 불변은 TS-26b가 담당**한다 —
  EP-3을 서브리소스로 뽑은 이유가 기존 응답을 안 건드리는 것이므로, 그 사실 자체를 테스트한다.
- 멱등성 재시도 계약은 해당 없음(GET 전용) — 대신 배치 멱등을 TS-02·10·16·30·42가 담당.

## E2E 후보 (최소 — 돈·법이 걸린 여정만)

1. 지도 → 정비구역 토글 ON → 폴리곤 클릭 → 사실 카드에 구역명·단계·기준일 표시 (Playwright,
   기존 `__auctionMapDebug` 훅 활용, 로컬 수동 실행).
2. 물건 상세 → 구역 사실 문장 + 노후도 문장 + 금칙어 부재 육안 확인 체크리스트.
3. **(M-5로 단위 테스트에서 빠진 몫)** 폴리곤이 실제로 그려지는지 · 토글 OFF 시 폴리곤 0개인지 ·
   기존 마커가 그대로인지 — 렌더 검증은 여기서만 한다. 단위 테스트는 이 셋을 검증하지 않는다는 점을
   완료 보고에 명시한다(공백을 숨기지 않기).

## 리스크 기반 커버리지 목표

- 최상(위협모델 1위 — 허위 사실 표시): 매칭·정규화 경로는 분기 커버리지 전수(TS-11~17) + 표본
  10구역 수동 대조(SC-002)를 릴리스 체크리스트에 포함.
- 상: 적재 멱등·대사(TS-01~06), 조인 정확성(TS-07~10).
- 중: API 계약(TS-18~19·25~26·26b·32), UI 문구·토큰(TS-23·24·27·37), 스타일 배정표(TS-21).
- 성능(TS-20)은 CI 밖 수동 — SC-003 판정 기록을 완료 보고에 첨부.

## P0/P1 요구사항 → 테스트 매핑 (누락 0 게이트 재확인, 2026-08-19)

| FR (우선순위) | 테스트 |
|---|---|
| FR-001 (P0) | TS-01·02·03·03b·04·05·06 |
| FR-002 (P0) | TS-07·08·09·10·35 |
| FR-003 (P0) | TS-11·12·13·14·15·15b·16·17·33·40 |
| FR-004 (P0) | TS-18·19·20·39 |
| FR-005 (P0) | TS-21·21b·22·23·24·38·39 |
| FR-006 (P0) | TS-23·25·26·26b·27 |
| FR-008 (P1) | TS-31·38 |
| FR-009 (P1) | TS-28·29·30 |
| FR-010 (P1) | TS-37 (+ 조인 키는 TS-41) |
| FR-011 (P1) | TS-33 |
| FR-012 (P1) | TS-32 |
| **FR-017 (P1)** | **TS-36·41·42** |
| FR-007·013~016 (P2) | 테스트 없음 — 범위 밖(DA-05R). 요구사항 없는 테스트도 0건 |

| SC | 테스트 |
|---|---|
| SC-001 | TS-01·06 |
| SC-002 | TS-12·13 + 표본 10구역 수동 대조 |
| SC-003 | TS-20 |
| SC-004 | TS-23 |
| SC-005 | TS-24 |
| SC-006 | TS-02·10·16·30·42 |
| SC-007 | TS-34 |
| SC-008 | TS-28 |
| SC-009 | TS-34 (등록 + 실행 + 통과 — 세 파일명이 러너 출력에 있고 fail 0) |

**누락 0. 요구사항 없는 테스트 0.**
