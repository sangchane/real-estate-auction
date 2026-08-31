<!-- NEXT-ACTION:START -->
## ▶ 지금 할 일 (새 세션은 이 블록부터 — SessionStart 훅이 자동 주입)

- **[제일 먼저]** **재수집이 실제로 PDF로 읽고 있는지 확인한다.** 08-31에 두 버그를 고쳤고
  (§4-33) 그 뒤 첫 회차가 돌고 있다. 판정은 `tenant_source` 분포 하나로 된다.

  ```
  # PDF_CELLS 가 늘고 있나 (08-31 10:00 기준: PDF_CELLS 10 / TEXT_LAYER 383 / NULL 3886)
  docker exec auction-db psql -U app -d auction -c "SELECT COALESCE(tenant_source,'(NULL)'), count(*) FROM auction_item_notice GROUP BY 1 ORDER BY 2 DESC;"

  # 회차 요약 — store_failed 가 0이 아니면 즉시 멈추고 원인부터 (조용히 두면 재조회 폭주로 이어진다)
  cd tools/collector && grep -a "daily_done\|daily_notice_store_failed" daily.log | tail -5
  ```

  `PDF_CELLS`가 안 늘면 Java 경로부터 본다 — `.env`의 `COLLECTOR_JAVA`가 Java 11+ 를
  가리켜야 한다(이 PC의 PATH java는 8이다). 08-31에 채웠지만 `.env`는 커밋되지 않으므로
  다른 PC에서는 다시 채워야 한다.

- **[다음]** **회차 소요가 정상으로 돌아왔는지 본다.** 버그 기간에 300~380분까지 늘어
  3시간 간격을 넘겼고 하루 8회가 3~6회로 줄었다. 정상은 8~50분이다.
  재수집 대상을 4,246 → 945건으로 줄였으니(기일 지난 것 제외) 회복돼야 한다.
  회복이 안 되면 `daily_notices`의 `skipped_existing`을 본다 — 0에 가까우면 여전히
  같은 문서를 다시 열고 있는 것이다.

- **[확인필요]** 오염 행 잔여 8건 — **기일이 오늘·내일이라 이번 주가 마지막이다.**
  08-31 기일(입찰 10:00 종료): notice 3691·3723 / 09-01 기일: 3559·3835·3844·4015·4030·4079.
  회수 불가 1건 notice 2268(기일 08-12). → WP-11 §4-29
  재수집 대기열이 기일 임박순이라 자동으로 앞에 오지만, 09-01분 449건과 경쟁한다.
  상한 40 × 남은 회차로 커버되는지 확인하고 모자라면 상한을 올린다(D-007 — 실측상
  한 회차 460건 근처에서 법원이 빈 응답으로 degrade한다).

- **[대기·사용자]** **구역 레이어 — 인증키 2건 발급이 착수 선행 조건이다.**
  ① 서울 열린데이터광장 인증키(무료·즉시, data.seoul.go.kr) → 정비구역 **추진단계**(FR-003 P0)
  ② 브이월드 계정(무료, vworld.kr) → 정비구역 폴리곤(FR-001 P0)·법정동 경계(FR-017 P1, 노후도 조인용)
  받는 곳·풀리는 것·발급 후 첫 순서 → `autopilot/redevelopment-zone-overlay/11-user-actions.md`
  기획은 5개 구역(정비구역·모아타운·재정비촉진·가로주택·신통)+노후도로 확장 완료. GATE 3차 CONCERNS.
- **[대기·사용자]** 실거래가 API 신청 — 승인되면 실부담 시나리오 기준을 감정가 → 시세로 전환.
- **[대기·사용자]** 등기부 운영 전환 — 커넥터·화면은 붙었고 지금은 데모(무료) 엔드포인트다.
  `.env`의 `CODEF_API_BASE`를 `https://api.codef.io`로 바꾸면 **1건에 700원**이 실제로 나간다.
  발급은 상세 화면의 버튼을 누를 때만 일어나고, 받은 등기부는 DB에 보관해 재과금이 없다.
<!-- NEXT-ACTION:END -->

<!--
규칙:
- 이 마커 사이는 "지금/다음 할 일" 1~3건만. 짧게(화면 한 판).
- 완료된 항목은 여기 두지 말고 WORKLOG.md 의 ## History 로 옮긴다 (단일 출처·비대 방지).
- 훅(tools/hooks/print_next_action.py)은 이 마커 사이만 세션에 주입한다.
-->
