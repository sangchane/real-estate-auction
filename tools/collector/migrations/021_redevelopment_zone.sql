-- 정비구역·모아타운 등 개발구역 레이어 스키마 (autopilot/redevelopment-zone-overlay/05-api-contract.md ERD).
--
-- 설계 문서는 이 마이그레이션을 017_ 로 적었지만 그 번호는 이미 명세서 텍스트 영역이 쓰고 있다.
-- 기존 테이블은 건드리지 않는다 — 전부 신규다.
--
-- **아직 데이터가 없다.** 원천 두 곳이 사용자 인증키·계정을 요구한다(11-user-actions.md):
--   - 서울 열린데이터광장 인증키 → 추진단계(FR-003)
--   - 브이월드 계정 → 정비구역 폴리곤·법정동 경계 SHP (익명 다운로드가 0바이트로 떨어짐, DA-09)
-- 스키마를 먼저 두는 이유는 적재기가 붙을 자리를 확정해 두기 위해서다. 빈 테이블은 조회에
-- 아무 영향을 주지 않는다.
--
-- `bjd_code` 자릿수는 SHP를 실제로 받아봐야 확정된다(A-V1·A-V3 미확인). 그래서 TEXT다 —
-- 숫자형으로 잡으면 앞자리 0이 사라지고, 자릿수를 못 박으면 원천이 다를 때 적재가 통째로 막힌다.

-- 개발구역 폴리곤. 대상지(후보)는 폴리곤이 없어 geom NULL + rep_point만 있다.
CREATE TABLE IF NOT EXISTS redevelopment_zone (
    id                       BIGSERIAL PRIMARY KEY,
    source                   TEXT NOT NULL,
    source_zone_id           TEXT NOT NULL,
    zone_kind                TEXT NOT NULL,
    zone_name                TEXT,
    sigungu                  TEXT,
    business_kind            TEXT,
    geom                     geometry(MultiPolygon, 4326),
    rep_point                geometry(Point, 4326),
    area_m2                  NUMERIC,
    current_stage            TEXT,
    current_stage_notice_date DATE,
    designated_at            DATE,
    -- 원천에서 사라진 행을 지우지 않고 마킹만 한다. 지우면 그 구역을 참조하던 물건 조인이
    -- 조용히 사라져, 화면에서 "구역 아님"과 "원천이 이번에 빠뜨림"을 구분할 수 없다.
    retired_at               TIMESTAMPTZ,
    source_updated_at        TIMESTAMPTZ,
    collected_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, source_zone_id, zone_kind)
);

CREATE INDEX IF NOT EXISTS redevelopment_zone_geom_idx ON redevelopment_zone USING GIST (geom);

COMMENT ON TABLE redevelopment_zone IS
    '개발구역(정비구역·모아타운 등). 원천 소실은 retired_at 마킹이고 행을 지우지 않는다';
COMMENT ON COLUMN redevelopment_zone.geom IS
    'MultiPolygon 4326. 대상지(후보)는 폴리곤이 없어 NULL이고 rep_point만 있다';
COMMENT ON COLUMN redevelopment_zone.current_stage IS
    '추진단계 비정규화 캐시. 매칭이 안 되면 NULL 이며, 화면은 NULL을 "단계 미확인"으로 읽는다';
COMMENT ON COLUMN redevelopment_zone.retired_at IS
    '이번 원천 파일에 있으면 NULL로 되돌린다 — 오염 복구(전체 마킹 후 재적재)가 전 구역을 영구 retired로 만들지 않게 (08 m-03)';

-- 추진단계 원문. 정규화 값은 매칭 단계에서 만들고 여기엔 셀 텍스트를 그대로 남긴다.
CREATE TABLE IF NOT EXISTS zone_stage_source (
    id             BIGSERIAL PRIMARY KEY,
    gu             TEXT,
    zone_name_raw  TEXT,
    business_kind  TEXT,
    stage_raw      TEXT,
    notice_date    DATE,
    observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw            JSONB
);

COMMENT ON TABLE zone_stage_source IS
    '추진단계 원천 행. stage_raw는 원문 그대로 — 정규화가 틀렸을 때 되돌릴 증거가 된다';

-- 구역 ↔ 단계 매칭. UNIQUE(zone_id)로 0..1 카디널리티를 DB가 강제한다.
CREATE TABLE IF NOT EXISTS zone_stage_match (
    zone_id         BIGINT NOT NULL REFERENCES redevelopment_zone (id) ON DELETE CASCADE,
    stage_source_id BIGINT NOT NULL REFERENCES zone_stage_source (id) ON DELETE CASCADE,
    match_method    TEXT NOT NULL,
    matched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (zone_id)
);

-- 수동 별칭. gu가 NULL이면 UNIQUE가 무력화되어 그 별칭이 영원히 매칭되지 않는다 (07 RB-3).
CREATE TABLE IF NOT EXISTS zone_alias (
    id              BIGSERIAL PRIMARY KEY,
    zone_id         BIGINT NOT NULL REFERENCES redevelopment_zone (id) ON DELETE CASCADE,
    gu              TEXT NOT NULL,
    source_name_raw TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (gu, source_name_raw)
);

-- 단계 변경 이력. UNIQUE를 두지 않는다 — A→B→A 재진입이 실제로 일어난다 (04 §3.4).
CREATE TABLE IF NOT EXISTS zone_stage_history (
    id          BIGSERIAL PRIMARY KEY,
    zone_id     BIGINT NOT NULL REFERENCES redevelopment_zone (id) ON DELETE CASCADE,
    stage_norm  TEXT,
    notice_date DATE,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zone_stage_history_zone_idx
    ON zone_stage_history (zone_id, observed_at);

-- 배치 실행 기록. 어떤 회차가 무엇을 몇 건 처리했는지 남긴다.
CREATE TABLE IF NOT EXISTS sync_run (
    id          BIGSERIAL PRIMARY KEY,
    job         TEXT NOT NULL,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    status      TEXT,
    counts      JSONB
);

-- 자동 매칭에 실패한 구역명과 후보들. 사람이 별칭을 만들 때 본다.
CREATE TABLE IF NOT EXISTS stage_match_report (
    id             BIGSERIAL PRIMARY KEY,
    sync_run_id    BIGINT REFERENCES sync_run (id) ON DELETE CASCADE,
    zone_name_raw  TEXT,
    normalized_key TEXT,
    candidates     JSONB
);

-- 물건 × 구역. 겹침이 실제로 있어 복합 유니크로 다대다를 그대로 표현한다.
CREATE TABLE IF NOT EXISTS auction_item_zone (
    auction_item_id BIGINT NOT NULL REFERENCES auction_item (id) ON DELETE CASCADE,
    zone_id         BIGINT NOT NULL REFERENCES redevelopment_zone (id) ON DELETE CASCADE,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auction_item_id, zone_id)
);

CREATE INDEX IF NOT EXISTS auction_item_zone_item_idx ON auction_item_zone (auction_item_id);

COMMENT ON TABLE auction_item_zone IS
    '물건×구역. ST_Intersects 기준(경계선 위=포함) — 구역은 겹칠 수 있어 포함이 안전하다';

-- 법정동 경계. 물건→법정동 공간조인의 기준이고, 노후도 집계가 이 코드에 붙는다.
CREATE TABLE IF NOT EXISTS bjd_dong (
    bjd_code          TEXT PRIMARY KEY,
    dong_name         TEXT,
    sigungu           TEXT,
    geom              geometry(MultiPolygon, 4326),
    source_updated_at TIMESTAMPTZ,
    collected_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bjd_dong_geom_idx ON bjd_dong USING GIST (geom);

COMMENT ON TABLE bjd_dong IS
    '법정동 경계. 소프트삭제 없이 전량 교체한다 — 폐지된 동을 남기면 조인이 옛 경계를 계속 가리킨다';

-- 물건 × 법정동. 동은 배타적 분할이라 정확히 0..1이고, 그래서 PK가 물건 하나다.
CREATE TABLE IF NOT EXISTS auction_item_dong (
    auction_item_id BIGINT PRIMARY KEY REFERENCES auction_item (id) ON DELETE CASCADE,
    bjd_code        TEXT NOT NULL REFERENCES bjd_dong (bjd_code) ON DELETE CASCADE,
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auction_item_dong_bjd_idx ON auction_item_dong (bjd_code);

COMMENT ON TABLE auction_item_dong IS
    '물건×법정동. ST_Contains 기준(경계선 위=미포함, 행 없음) — 포함 기준을 쓰면 한 물건이 두 동에 속하는 모순이 생긴다';

-- 동별 노후도 집계. 비율이 아니라 분자·분모를 저장한다 — 반올림 정책을 API 한 곳에 고정하기 위해서다.
CREATE TABLE IF NOT EXISTS building_age_dong (
    bjd_code          TEXT NOT NULL,
    base_ym           TEXT NOT NULL,
    dong_name         TEXT,
    total_count       INT,
    unknown_apr_count INT,
    over20_count      INT,
    over30_count      INT,
    loaded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (bjd_code, base_ym)
);

COMMENT ON COLUMN building_age_dong.total_count IS
    '사용승인일이 있는 건물 수(분모). 0이면 화면은 비율을 내지 않는다 — 0%로 쓰면 "노후 건물 없음"으로 읽힌다';
COMMENT ON COLUMN building_age_dong.unknown_apr_count IS
    '사용승인일 결측 건물 수. 분모에서 뺀 값이라 따로 남긴다 (엣지 C-3)';
COMMENT ON COLUMN building_age_dong.base_ym IS
    'YYYY-MM. 시간 정보가 없는 원천이라 date로 올리지 않는다 — 없는 시각을 발명하지 않는다';
