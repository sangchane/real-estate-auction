<!-- NEXT-ACTION:START -->
## ▶ 지금 할 일 (새 세션은 이 블록부터 — SessionStart 훅이 자동 주입)

- **[확인필요·오늘]** **WAF 차단이 지속되는지** — 08-20 10:01:59에 pvo 문서 요청이 차단됐다
  (원인: 없는 경로 4개 연속 시도, WP-11 §4-30). 12:00 정기 회차가 정상 완주하면 일시적이다.
  → `tools/collector/daily.log`의 `daily_done`·`notice_unavailable`
- **[진행중]** **점유자 표를 PDF 괘선으로 파싱하도록 전환** (WP-11 §4-30에서 방향 확정).
  좌표만으로 푸는 길은 실측으로 기각했고, 원본 PDF를 정상 경로로 받을 수 있음을 확인했다
  (`GET /streamdocs/v4/documents/{id}` → `%PDF-1.4`). `opendataloader-pdf`가 병합셀을
  `row span`으로 정확히 가른다. **다음 단계는 실제 명세서 1건 검증** — 점유자 표가 하나로
  잡히는가(등기부에서는 표를 과분할했다). 하네스는 준비돼 있다.
  주의: 문서 취득은 **알려진 엔드포인트 1개만** 호출한다. 경로 탐색 금지.
  → `tools/collector/src/collector/notice_tenant_parser.py`, `notice_document_client.py`
- **[대기·결정]** Java 11+ 런타임 도입 여부 — opendataloader는 JAR이라 Java가 필요하다.
  이 PC는 JDK 21이 있는데도 `java`가 8로 잡히므로 `run_daily.cmd`에 경로 명시가 필요하다.
- **[확인필요]** 오염 행 재수집 잔여 10행 — notice 3316(창 08-20 개시, 마커 비움 완료)은
  12:00 회차가 받는지 본다. 나머지: 08-24 개시 3691·3723 / 08-25 개시 3835·3844·4015·4030·4079·3559.
  회수 불가 1건 notice 2268. → WP-11 §4-29
- **[대기·사용자]** 정비구역 오버레이 기획 착수 조건 — GATE 3차 CONCERNS. 서울 열린데이터광장
  인증키·브이월드 계정 발급이 선행이다. → `autopilot/redevelopment-zone-overlay/09-readiness-report-gate3.md`
- **[대기·사용자]** 실거래가 API 신청 — 승인되면 실부담 시나리오 기준을 감정가 → 시세로 전환.
  → `apps/api/src/rights-analysis/domain/total-burden.ts`
<!-- NEXT-ACTION:END -->

<!--
규칙:
- 이 마커 사이는 "지금/다음 할 일" 1~3건만. 짧게(화면 한 판).
- 완료된 항목은 여기 두지 말고 WORKLOG.md 의 ## History 로 옮긴다 (단일 출처·비대 방지).
- 훅(tools/hooks/print_next_action.py)은 이 마커 사이만 세션에 주입한다.
-->
