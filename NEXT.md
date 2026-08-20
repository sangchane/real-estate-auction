<!-- NEXT-ACTION:START -->
## ▶ 지금 할 일 (새 세션은 이 블록부터 — SessionStart 훅이 자동 주입)

- **[제일 먼저]** **밤새 회차에서 PDF 경로가 실제로 돌았는지 확인한다.** 08-20 15:42에
  코드를 넣었고 첫 적용은 **18:00 회차**다. 그 전에 법원이 `ipcheck`만 담긴 빈 응답을 주기
  시작해(요청 과다, 실측상 3시간 뒤 복구) 회복 여부도 같이 봐야 한다.

  ```
  # ① 회차가 완주했나 / 빈 응답은 없었나
  cd tools/collector && grep -a "daily_done\|notice_pdf_failed\|BlockedByCourt" daily.log | tail -20

  # ② PDF 경로가 쌓이고 있나 (018)
  docker exec auction-db psql -U app -d auction -c     "SELECT tenant_source, count(*) FROM auction_item_notice GROUP BY 1 ORDER BY 2 DESC;"
  ```

  판정: `PDF_CELLS`가 늘어 있으면 성공. `notice_pdf_failed`가 많으면 폴백만 도는 것이고
  대개 **Java 경로**다(이 PC는 PATH의 java가 8이다 — `.env`에 `COLLECTOR_JAVA` 필요).
  `stage_failures>0`이거나 `notice_unavailable`이 크면 아직 법원이 degrade 중이다.

- **[다음]** **재수집을 건다** — 위 확인이 정상일 때만. 열람 창이 열린 명세서가 1,112건이고
  전부 텍스트 레이어로 읽힌 것이라 임차인 행·사람이 어긋나 있다. `needs_tenants` 조건에
  "`tenant_source`가 `PDF_CELLS`가 아닌 것"을 더하고 **회차당 상한(~60건)** 과 **기일 임박순
  정렬**을 둔다. 기일 분포: 08-24 101건 / **08-25 548건** / 08-26 169건 / 08-27 165건.
  스케줄은 이미 3시간마다(하루 8회)라 상한 60이면 기한 내에 들어온다.
  → `tools/collector/src/collector/runner.py`(needs_tenants), WP-11 §4-31

- **[확인필요]** 오염 행 잔여 **9행** — 창이 여는 날 `tenant_scanned_at`을 비운다.
  08-24 개시: notice 3691·3723 / 08-25 개시: 3835·3844·4015·4030·4079·3559.
  회수 불가 1건 notice 2268. → WP-11 §4-29

- **[대기·사용자]** 정비구역 오버레이 착수 조건 — GATE 3차 CONCERNS. 서울 열린데이터광장
  인증키·브이월드 계정 발급이 선행. → `autopilot/redevelopment-zone-overlay/09-readiness-report-gate3.md`
- **[대기·사용자]** 실거래가 API 신청 — 승인되면 실부담 시나리오 기준을 감정가 → 시세로 전환.
<!-- NEXT-ACTION:END -->

<!--
규칙:
- 이 마커 사이는 "지금/다음 할 일" 1~3건만. 짧게(화면 한 판).
- 완료된 항목은 여기 두지 말고 WORKLOG.md 의 ## History 로 옮긴다 (단일 출처·비대 방지).
- 훅(tools/hooks/print_next_action.py)은 이 마커 사이만 세션에 주입한다.
-->
