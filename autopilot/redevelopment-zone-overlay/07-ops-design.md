# 배포·운영 설계 — 정비구역·모아타운·노후도 지도 레이어

> **GATE 2차(08 리포트) 반영 2026-08-19.** 초판(08-18 15:41)은 03~06보다 먼저 저장돼 GATE 1차가
> 빠져 있었고, 그 뒤 데이터원 2개가 통째로 바뀌었다(DA-03R2·DA-04R). 이 문서는 그 두 축을
> 반영한 판이다 — 08의 B-1·M-6·m-02·m-03·m-07·m-08·m-09·m-16이 여기서 닫힌다.

## 배포

- 런타임·형상: **신규 인프라 0.** 기존 구성 그대로 — auction-db 도커(PostGIS), collector는
  run_daily.cmd(Windows, Docker·DB 선기동 순서 유지), api·web은 기존 pnpm 실행. 신규 실행물:
  - collector **배치 함수 4개(3개 아님 — 08 m-16)** — `shp_importer`(VWORLD_ZONE·VWORLD_DONG·
    SEOUL_SEED 공용) · `stage_sync` · `building_age_loader` · **`zone_join`**. zone_join은 월간
    전체 재계산과 일일 증분 2트리거로 도는 실행물이라 관측 대상이다. `sync_run.job` enum도 같은
    5값으로 맞춘다: `shp_importer_zone` · `shp_importer_dong` · `stage_sync` ·
    `building_age_loader` · **`zone_join`** (05 ERD와 동일).
  - collector **신규 모듈 1개** — `geocode_client.py`(카카오 로컬 주소검색). **신규 외부 연동
    1건**이며 초판이 공수에서 통째로 빠뜨렸다(08 M-6) — 아래 별항으로 계상한다.
  - collector **신규 CLI 서브커맨드 1개** — `zones`(`__main__.py`의 첫 positional 분기에 추가).
  - **신규 파이썬 의존성 1개 — `pyshp`**(SHP 파싱, 08 m-09). 현재 `pyproject.toml`의 런타임
    의존성은 `psycopg[binary]`·`pyproj` 둘뿐이라 `dependencies`에 1줄 추가가 필요하다(실측).
    **좌표변환은 PostGIS `ST_Transform` 한 곳에서만** 하고 `pyproj`는 기존 KATEC 경로(`geo.py`)
    전용으로 남긴다 — 신규 SHP 경로는 pyproj를 쓰지 않는다(변환 지점이 둘이면 어긋났을 때 어느
    쪽이 맞는지 알 수 없다).
  - **드롭 폴더 1개** — `tools/collector/data/zones/`(브이월드 zip 투입처, DA-09).
  - api 모듈 1개(map-layers) + auction-items 서브리소스 1개(`zone-facts`), web 모듈 파일 수 개.
- 마이그레이션: 017_zone_layers.sql 1개 — 전량 재실행 환경이므로 모든 DDL이 IF NOT EXISTS 계열.
  기존 테이블 변경 없음(신규 테이블만) → 롤백 = 신규 테이블 DROP(데이터는 원천 재적재 가능).
  - **적용 주체 = 사람, 최초 1회 (08 m-07).** `run_daily.cmd`는 `--migrate` 없이
    `python -m collector daily --with-tenants`를 돌리고, 주석 13행에 "Migrations are NOT run here -
    schema changes are applied by hand after review"라고 못박혀 있다(실측). 그러므로 배포 절차에
    이 한 줄을 명시한다 —
    017_ 리뷰 후 `cd tools/collector && .venv\Scripts\python.exe -m collector zones --migrate`.
    `run_migrations`는 추적 테이블 없이 `migrations/*.sql` 전부를 재실행하므로 몇 번 돌려도 안전하다.
    **"수동 개입 기본 0"의 예외는 이 1회와 DA-09의 월 1회 파일 투입, 둘뿐이다.**
  - `zone_alias.gu`는 **`NOT NULL`로 만든다.** UNIQUE(gu, source_name_raw)에서 NULL은 서로 구별되는
    값이라, gu가 비면 같은 원문 별칭이 무제한 들어가는 데다 매칭 키가 (자치구, 원문)이므로 **그
    행은 영원히 매칭되지 않는다** — 아래 RB-3 복구 절차가 조용히 아무 일도 안 하는 경로다(08 m-02).
- CI/CD 단계(로컬 검증 파이프라인): ruff → pytest → pnpm -r lint → pnpm -r test → pnpm -r build →
  **(최초 1회) 017_ 수동 적용** → (수동) run_daily 1회 관찰 → 지도 화면 스모크(토글·클릭·상세).
- **설정·비밀 (08 B-1 반영 — 원천이 바뀌었다)**:
  - **`SEOUL_OPEN_DATA_API_KEY` — 신규 env 1개, 그대로 유지한다.** 종료된 OA-2253을 대체한
    **OA-22856 / `TbSeoulRedevStatus`가 같은 `openapi.seoul.go.kr:8088` 표준 Open API**이기
    때문이다(DA-04R, 2026-08-19 실호출로 확인: `list_total_count`=472, `RESULT.CODE`=`INFO-000`).
    즉 08 리포트가 예상한 "단계 동기화를 파일 배치로 갈아엎기"는 **일어나지 않았다.** 파일 배치로
    바뀐 쪽은 **폴리곤·법정동**(브이월드 드롭 폴더)이다. `.env.example`에는 키 이름만 추가하고 값은
    `.env`에 둔다. 발급은 사용자 행위(무료·즉시 — 03 U-7).
  - **`KAKAO_REST_API_KEY` — "기존 키 재사용"이 아니라 최초 사용이다 (08 M-6).** 실측: 이 이름은
    리포 전체에서 `.env.example:36` 한 줄에만 나오고 **읽는 코드가 없다.** `geocode_client.py`가
    첫 소비자가 되므로 "값이 실제로 채워졌는지"를 배포 체크리스트 항목으로 둔다(빈 값이면 좌표가
    전건 NULL이 되고, 그 실패는 조용하다).
  - `DATABASE_URL` · `COLLECTOR_REQUEST_INTERVAL_MS`(1500) · `COLLECTOR_MAX_RETRY`(3)는 기존 값
    그대로 재사용 — 신규 클라이언트도 같은 예절 설정을 쓴다(D-007).
  - 파일 경로 2개: **드롭 폴더** `tools/collector/data/zones/`(버전 관리 제외 — 원본 zip 보관은
    아래 백업 규칙), **시드 CSV** `tools/collector/data/moatown_sites.csv`(버전 관리 대상 — 원천이
    보도자료라 파일이 곧 출처 기록, 출처 URL·기준일 컬럼 포함).
  - **키 노출 주의**: 단계 API는 TLS를 받지 않는다 — 443 무응답, 8088에 TLS로 붙으면 핸드셰이크
    실패(2026-08-19 실측). 인증키가 평문 URL 경로에 실려 나가므로 **로그 기록 전 `{KEY}` 치환은
    선택이 아니라 필수**다(04 위협모델 ③, 규칙 8).
- **신규 외부 연동 1건 — 카카오 로컬 지오코딩 `geocode_client.py` (08 M-6)**: 초판 04·07은 이 일을
  "기존 수집기의 주소→좌표 관례 재사용"으로 적었으나 **그런 관례가 없다.** `geo.py`는 법원이 주는
  KATEC 평면좌표를 pyproj로 WGS84로 바꿀 뿐 주소를 다루지 않고, 리포에 주소 지오코딩 호출이 0건이다
  (실측). 그래서 운영 항목을 새로 계상한다.
  - 대상·규모: 모아타운 대상지 시드 CSV의 대표지번 **132건**(2026-03 기준), 분기 1회 갱신 — 상시
    호출이 아니라 CSV가 바뀔 때만 도는 경로다.
  - 호출: `GET https://dapi.kakao.com/v2/local/search/address.json?query={지번주소}`, 헤더
    `Authorization: KakaoAK {KAKAO_REST_API_KEY}`, 응답의 `x`=경도 · `y`=위도.
    (공식 문서 2026-08-19 확인 — https://developers.kakao.com/docs/ko/local/dev-guide )
  - D-007 준수: `COLLECTOR_REQUEST_INTERVAL_MS` 간격 유지, 재시도 대기는 **기존 `backoff.py`의
    `backoff_delay_ms(attempt)` 재사용**(순수 함수라 sleep은 호출자 몫), `COLLECTOR_MAX_RETRY`
    초과나 4xx 반복이면 **우회하지 않고 중단·알림**. HTTP는 stdlib `urllib`(수집기에 requests·
    httpx 의존성이 없다 — 실측).
  - 응답 검증: 규칙 21의 Python판 — `documents[0].x/y`의 존재와 수치 변환을 **명시 검증**한 뒤에만
    좌표로 쓴다(신뢰 캐스팅 금지). 검증 실패는 성공이 아니라 실패로 센다.
  - 실패 처리: `rep_point` NULL로 저장 + 실패 목록 로그(조용히 버리지 않기 — collector 관례,
    엣지 C-1). 지도에 표시하지 않고, 없는 좌표를 지어내지 않는다.
  - 로그: 질의 주소와 실패 사유는 남기고 **키는 마스킹**. 개인정보 없음(대표지번은 공개 공고 값).
  - **미확인**: 카카오 로컬 API의 일일 쿼터와 앱별 활성화 조건. 공식 dev-guide에 수치가 없고 별도
    쿼터 페이지로 넘긴다. 132건 규모라 걸릴 이유가 없어 보이지만 **수치를 단정하지 않는다** —
    착수 전 확인 액션 **A-V7**(01-recon §7).

## 관측성

- SLI 선택(파이프라인+사용자 대면 혼합):
  1. 신선도 — 각 job의 마지막 SUCCESS 이후 경과일 (sync_run에서 파생)
  2. 정합성 — 대사 불일치 건수, 단계 미매칭 비율(미매칭/전체)
  3. 사용자 대면 — EP-1 응답 시간·에러율(기존 API 로깅 규약에 편승)
- SLO-lite (100% 금지, 사용자 기대 기준):
  - **단계 신선도 ≤ 10일 — 이것은 "배치 실행" 신선도이지 원천 값의 신선도가 아니다.** 층위가
    셋이라 섞어 쓰면 그 자체가 거짓 표기가 된다(08 m-04·m-12 정리):
    ① **배치 가드 6일** — 마지막 성공이 6일 이내면 스킵(04 §3.4. 문서군 전체를 6일로 통일했다)
    ② **SLO 10일** — 마지막 SUCCESS 이후 경과일(주간 실행 + 여유 3일). 초과 시 RB-2
    ③ **원천 갱신주기 분기** — OA-22856 데이터셋 메타 실확인(2026-08-19). 따라서 **화면에 뜨는
       단계 값 자체는 최대 1분기 뒤처질 수 있다.** 이 지연은 숨기지 않고 원천 기준일로 그대로
       전달한다(DA-04R).
    초판 02가 쓴 "신선도 목표 = 단계 7일"은 ①의 가드를 신선도로 옮겨 적은 것이라 폐기한다.
  - 폴리곤·법정동 적재 신선도 ≤ 40일(27일 가드 + 여유), 노후도 ≤ 40일. **폴리곤은 드롭 폴더가
    비어 있으면 SKIPPED로 끝난다**(자동 다운로드를 시도하지 않는다 — DA-09) → SKIPPED가 반복되면
    신선도가 마르므로 RB-5로 사람을 부른다. 이 알람이 곧 "월 1회 사람 손"의 관측 지점이다.
  - `zone_join`은 별도 신선도 SLO를 두지 않는다 — 일일 증분이 run_daily에 붙어 물건 적재와 같은
    주기로 돌기 때문이다. 대신 **FAILED와 미배정 건수**를 sync_run.counts로 관측한다(08 m-16).
  - 단계 자동 매칭률 ≥ 90% (초기 낮음 허용 — 별칭 보정으로 수렴시키는 지표이지 차단 게이트 아님)
  - EP-1 로컬 p95 ≤ 500ms (SC-003)
- 골든 시그널 계측: Latency(EP-1 — 기존 API 로그) / Traffic(EP-1 호출 수) / Errors(배치 FAILED,
  EP-1 5xx) / Saturation(적재 중 DB 용량 — 신규 테이블 크기를 배치 로그에 기록).
- **로깅 전략 (무엇을·어디에·얼마나)**:
  - 무엇을: 배치별 구조화 1행 요약 — job(위 5값), 원천 건수, upsert, **retired / retired 해제**,
    MakeValid 보정, 미매칭, 지오코딩 실패, 제외 건수, 소요시간, status. `zone_join`은 조인 행
    생성·삭제 수와 **동 미배정 건수**(경계선 위·geom NULL)를 함께 남긴다. `shp_importer`는
    **읽은 zip 파일명과 원천 갱신일**을 남긴다 — 사람이 넣은 파일이라 "무엇을 적재했는지"가
    파일 이름 말고는 증거가 없다. 상세 실패는 행 단위 WARN. 요청 식별자·업무 키·처리 건수·
    실패 원인 추적 가능(규칙 7).
  - 어디에: 기존 collector 로그 파일(`tools/collector/daily.log`) + sync_run 테이블(질의 가능한
    이력). API는 기존 NestJS 로그.
  - 얼마나: 로그 파일은 기존 로테이션 정책 편승, sync_run·stage_match_report는 **1년 보존 후
    연 1회 정리**(행 수 작음 — 연 수백 행).
  - 마스킹: 서울 API 키가 **평문 HTTP URL 경로**에 포함되므로 로그 기록 전 `{KEY}` 치환.
    카카오 키는 헤더에 실리므로 헤더를 통째로 로그에 넣지 않는다(위협모델 ③ 대응).

## 알림 (모든 알람은 조치 가능해야 — 알람:런북 1:1)

| 조건 | 심각도 | 수신자 | 연결 런북 |
|---|---|---|---|
| 배치 status=FAILED (스키마 검증 실패·파싱 실패·건수 급변) — job 5종 공통, `zone_join` 포함 | 높음 | 운영자(기존 run_daily 실패 통지 경로) | RB-1 |
| 단계 **실행** 신선도 > 10일 (sync_run 기준 — run_daily 시작 시 자가 점검 출력) | 중간 | 운영자 | RB-2 |
| 미매칭 비율 > 30% 급증 (직전 실행 대비) | 중간 | 운영자 | RB-3 |
| EP-1 5xx 발생 | 높음 | 운영자(기존 API 관찰 경로) | RB-4 |
| **폴리곤·법정동 적재가 2회 연속 SKIPPED**(드롭 폴더가 비어 있음 — DA-09의 월 1회 투입 누락) | 중간 | 운영자 | RB-5 |
| **원천 소멸·개편 징후** — 단계 API가 `RESULT.CODE != INFO-000`을 2회 연속 반환하거나 데이터셋 페이지에 종료 표기 | 높음 | 운영자 | RB-6 |

원인 지표(미매칭 절대 수, 지오코딩 실패 수, 테이블 크기 등)는 알람이 아니라 sync_run 질의·완료
보고로 관찰한다 — 알람:런북 1:1을 지키기 위해 런북이 없는 지표는 알람으로 올리지 않는다.

RB-5·RB-6은 이번 판에서 새로 생겼다. RB-5는 취득이 사람 손에 걸려 있다는 사실(DA-09)에서,
RB-6은 **OA-2253이 실제로 종료된 사건**에서 나왔다 — 원천이 사라지는 일은 가정이 아니라 이미 한 번
일어난 일이라 런북을 갖춰 둔다.

## 장애·복구

| 장애 | 감지 | 영향 | 복구 절차(복붙 수준) | RTO / RPO |
|---|---|---|---|---|
| 원천 API·파일 장기 중단 | RB-1 알림 반복 | 데이터 스테일(화면은 기준일 표기로 사실 유지) | 없음(대기) — 화면 기준일이 사실을 말함. 2주 초과 시 원천 공지 확인 | RTO 없음(기능 저하 아님) / RPO=원천 갱신 주기 |
| 오염 적재(잘못된 폴리곤) | 대사 경고·표본 대조 실패 | 허위 경계 표시 위험 | ① `UPDATE redevelopment_zone SET retired_at = now() WHERE source = 'VWORLD_DL';` ② 드롭 폴더에 **정상 zip**을 넣고 `python -m collector zones --job shp_importer_zone --force` ③ 임포터가 **이번 파일에 있는 행의 `retired_at`을 NULL로 되돌린다**(05 데이터 규칙·04 데이터 저장·TS-03b) — 이 해제 규칙이 있어야 이 절차가 "전 구역 영구 retired"로 끝나지 않는다(08 m-03) ④ `zone_join.recompute()`가 임포터 끝에서 자동 호출되며 `auction_item_zone`을 다시 만든다(수동 `DELETE`는 하지 않는다 — 조인은 파생물이라 재계산이 곧 복구) | RTO 1시간 / RPO 0(원천이 진실) |
| 오염 적재(잘못된 단계) | 대사 경고·표본 대조 실패 | 허위 단계 표시 위험 | `python -m collector zones --job stage_sync --force` 재실행 — 매 실행이 `zone_stage_match` 전체를 재계산하므로 원천이 정상이면 그것으로 복구된다. 원천 자체가 틀렸으면 고칠 수단이 없다(Accept — 화면의 출처·기준일이 책임 소재를 사실대로 말한다) | RTO 30분 / RPO 0 |
| 신규 테이블 손상·유실 | 배치 오류·API 5xx | 레이어 미표시(기존 지도 기능 무영향 — 레이어는 부가물) | `python -m collector zones --migrate`(017_ 재실행, 멱등) → **배치 4종 수동 실행**(`shp_importer_zone` → `shp_importer_dong` → `stage_sync` → `building_age_loader`, 마지막에 `zone_join`이 따라온다). 폴리곤 zip은 아래 백업 규칙의 아카이브에서 꺼내 드롭 폴더에 넣는다 | RTO 반나절 / RPO 0 |
| 단계 오매칭 발견(사용자 신고·표본 대조) | RB-3·수동 | 특정 구역 허위 단계 | `INSERT INTO zone_alias(zone_id, gu, source_name_raw) VALUES (...);` 후 `stage_sync` 재실행 — MANUAL이 AUTO에 우선. **`gu`를 빠뜨리면 안 된다**: UNIQUE(gu, source_name_raw)이고 매칭 키가 (자치구, 원문)이라, gu 없는 별칭은 에러 없이 들어가서 **영원히 매칭되지 않는다**(08 m-02. 그래서 컬럼을 NOT NULL로 만든다) | RTO 10분 / RPO 0 |
| **드롭 폴더 미투입(월 1회 사람 손 누락)** | RB-5(2회 연속 SKIPPED) | 폴리곤·법정동 스테일. 기존 적재분으로 계속 서빙되고 화면 기준일이 사실을 말한다 | 브이월드에 로그인해 `LSMD_CONT_UD602_5174_서울.zip` / `LSMD_ADM_SECT_UMD_서울.zip`을 받아 드롭 폴더에 넣고 `python -m collector zones --job shp_importer_zone --force` + `--job shp_importer_dong --force`. 자동 다운로드는 시도하지 않는다(DA-09 B안 미채택) | RTO=사람 가용시간 / RPO=원천 갱신("변경발생시") |
| **원천 데이터셋 종료·개편** | RB-6 | 해당 원천의 갱신 정지(기존 데이터는 유지·표시) | 우회하지 않는다. ① 화면 기준일이 스테일을 사실대로 말하는지 확인 ② 01-recon §4b·§7의 대체 후보로 재선정(단계: 정보몽땅 A-V4 / 폴리곤: data.go.kr A-V5·브이월드 데이터 API A-V6) ③ 원천이 바뀌면 decision-log에 DA로 남기고 04 §3.4·05·06·07을 같은 커밋에서 고친다. **이 절차의 근거는 실제 사건이다 — OA-2253이 2026-08-19자로 종료됐다** | RTO=재선정 소요(수일) / RPO=원천 갱신 주기 |
| DB 컨테이너 유실 | run_daily 기동 실패 | 전체 서비스 | 기존 DB 복구 절차(아래 백업) + 본 기능 테이블은 배치 재실행으로 재구축 | 기존 정책 준수 |

- **백업 (무엇을 / 얼마나 / 어디에)**: 신규 테이블은 대부분 **원천에서 재적재 가능** → 전용 DB
  백업을 만들지 않는다(무엇을: 없음 / 주기: 해당없음 / 보관처: 원천이 곧 백업). **예외 3건**은
  "원천에서 다시 못 얻거나 사람 손이 들어간" 산출물이라 따로 챙긴다.

  | 무엇을 | 얼마나 | 어디에 | 이유 |
  |---|---|---|---|
  | `moatown_sites.csv` | 변경 시마다 | git 커밋(버전 관리가 곧 백업) | 원천이 보도자료라 파일이 곧 출처 기록 |
  | `zone_alias` 덤프 | 월 1회 `COPY zone_alias TO '...csv' CSV HEADER;` | git 관리 폴더 | 사람이 손으로 만든 유일한 데이터. 재생성 수단이 없다 |
  | **브이월드 원본 zip 2종** | 투입할 때마다 1부, **12개월 보존**(월 1개 × 약 2.2 MB → 연 30 MB 미만) | `tools/collector/data/zones/archive/YYYYMM/` (git 제외) | **원천이 로그인 뒤에 있어 배치가 다시 내려받을 수 없다**(DA-09). 이 zip이 없으면 폴리곤 복구가 "사람이 다시 로그인해서 받아오기"가 된다 |

  복원 리허설: 분기 1회 "신규 테이블 DROP → `zones --migrate` → 아카이브 zip을 드롭 폴더에 복사 →
  배치 4종 → 표본 대조" 드릴 — 위 표의 **"신규 테이블 손상·유실"** 행과 같은 경로다(리허설이 곧
  절차 검증). 아카이브 zip이 없으면 이 리허설 자체가 불가능하므로, 백업 3행은 장식이 아니다.
- 런북 골격(RB-1 예시): 트리거=배치 FAILED 알림 → 영향=해당 job 데이터 스테일 → 진단=`SELECT *
  FROM sync_run ORDER BY id DESC LIMIT 5;` + 배치 로그 tail → 해결=원인별(네트워크: 재실행 /
  스키마 변경: 파서 수정 후 재실행 / 원천 개편: RB-6) → 검증=재실행 SUCCESS +
  화면 기준일 갱신 → 롤백=불필요(실패는 기존 데이터를 건드리지 않는 설계).

## 운영 메모 (규칙 17)

- 실행: run_daily가 가드 판단으로 알아서 주간·월간 배치를 돌린다. **사람 손은 두 곳뿐** —
  ① 017_ 최초 1회 수동 적용 ② 월 1회 브이월드 zip을 드롭 폴더에 넣기(DA-09, 약 5분).
- **CLI 형식은 기존 관례를 그대로 따른다 (08 m-08).** 실측: `__main__.py`는 `sys.argv[1:]`의
  **첫 positional 값**으로 모드를 고르고(`backfill`·`sweep`·`notices`·`photos`·`daily`·`mask`,
  그 외는 물건 수집), 각 모드가 자기 argparse 파서를 갖고 **모두 `--migrate` 플래그를 지원**한다.
  그래서 신규 모드도 서브커맨드 `zones` 하나로 붙인다. 초판의 `python -m collector.zones ...`는
  **모듈 경로 호출**이라 이 관례가 아니다.
  ```
  python -m collector zones --migrate                      # 최초 1회: 017_ 적용
  python -m collector zones --job stage_sync --force       # 가드 무시 강제 실행
  python -m collector zones --job shp_importer_zone --force
  python -m collector zones --job shp_importer_dong --force
  python -m collector zones --job building_age_loader --force
  python -m collector zones --job zone_join --force
  ```
  `--job` 값은 **`sync_run.job` enum과 같은 문자열 5종**을 쓴다(05 ERD) — 로그·알람·CLI가 같은
  이름을 쓰지 않으면 런북이 번역기를 요구하게 된다.
- 신선도 확인: `SELECT job, max(finished_at) FROM sync_run WHERE status='SUCCESS' GROUP BY job;`
- 드롭 폴더 상태 확인: `dir tools\collector\data\zones\*.zip` — 파일이 있으면 다음 월간 실행이
  적재하고, 적재 후 `archive\YYYYMM\`으로 옮긴다.
- 별칭 보정 방법과 표본 대조 체크리스트는 구현 시 tools/collector/README에 기재.
