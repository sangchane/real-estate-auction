-- 용도지역(도시지역) 폴리곤 스키마 (autopilot/redevelopment-zone-overlay/12-age-zoning-layer.md §2.5).
--
-- 원천: 서울 열린데이터광장 OA-21136 (공공누리 1유형, 인증키 불요 — §2.2).
-- redevelopment_zone과 달리 원천키 UNIQUE도 retired_at도 없다 — 원천 식별자(PRESENT_SN)가
-- 유일하지 않아(실측 2026-09-01: 8,312행 중 고유 8,221, 중복 키 41개 최대 13회, 공란 1)
-- upsert 키를 만들 수 없고, 구역과 달리 소실 이력 요구도 없다. 멱등은 적재기가
-- 같은 source 안에서 파일 단위 전량 교체(단일 트랜잭션 DELETE→INSERT)로 만든다.

CREATE TABLE IF NOT EXISTS zoning_district (
    id            BIGSERIAL PRIMARY KEY,
    source        TEXT NOT NULL,
    base_ym       TEXT NOT NULL,
    present_sn    TEXT,
    lclas_cl      TEXT,
    mlsfc_cl      TEXT,
    sclas_cl      TEXT,
    zone_name_raw TEXT,
    zoning_bucket TEXT,
    geom          geometry(MultiPolygon, 4326),
    area_m2       NUMERIC,
    notice_sn     TEXT,
    collected_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zoning_district_geom_idx ON zoning_district USING GIST (geom);
CREATE INDEX IF NOT EXISTS zoning_district_bucket_idx ON zoning_district (zoning_bucket);

COMMENT ON TABLE zoning_district IS
    '용도지역(도시지역) 폴리곤. 원천 식별자가 유일하지 않아 소프트삭제 없이 source 단위 전량 교체한다';
COMMENT ON COLUMN zoning_district.source IS
    '''SEOUL_OA21136''. 폴백 원천(토지이음) 교체 대비 — 전량 교체도 이 값 안에서만 해서 파일 한 장이 남의 레이어를 못 내린다';
COMMENT ON COLUMN zoning_district.base_ym IS
    '원천 파일 기준연월(YYYY-MM, 배포 파일명의 YYYYMM). 갱신 실주기가 불명(§7 U-A)이라 데이터가 언제 것인지 값이 화면 출처 표기까지 스스로 운반한다';
COMMENT ON COLUMN zoning_district.present_sn IS
    '원천 도형번호 원문. 유일하지 않아(중복 41키) 키가 아니다 — 원천 도면과 표본 대조(§7 U-G)할 증거로만 남긴다';
COMMENT ON COLUMN zoning_district.mlsfc_cl IS
    '중분류 코드 원문. 소분류 공란 행(실측 25%)에서는 이 값이 매핑 키다';
COMMENT ON COLUMN zoning_district.sclas_cl IS
    '소분류 코드 원문. 공란 허용 — 원천이 그렇다(준주거·상업·녹지 등은 중분류에만 코드가 있다)';
COMMENT ON COLUMN zoning_district.zone_name_raw IS
    'DGM_NM 원문. 코드-명칭 불일치(실측 존재)의 증거 보존 — 명칭으로 코드를 덮어쓰지 않는다';
COMMENT ON COLUMN zoning_district.zoning_bucket IS
    '채색 버킷(RES_EXCLUSIVE·RES_GENERAL_1·2·3·RES_SEMI·OTHER). NULL = 미분류(중립 렌더) — 사전에 없는 코드·코드-명칭 불일치를 가까운 버킷에 추측 배정하면 허위 사실이 된다';
COMMENT ON COLUMN zoning_district.geom IS
    'MultiPolygon 4326. 원천에 도형이 없는 행(실측 1건)은 NULL — 행을 버리면 원천에 있었다는 사실이 사라진다';
COMMENT ON COLUMN zoning_district.area_m2 IS
    'DGM_AR 원문(원천이 적은 면적). 재계산하지 않는다 — 원천 표기와 다른 값을 만들지 않기 위해서다';
COMMENT ON COLUMN zoning_district.notice_sn IS
    'NTFC_SN 고시번호 원문(관측 표본 다수 공란)';

-- 물건 × 용도지역. 기획(12 §2.5)은 배타 분할을 전제로 ST_Contains·물건당 한 행을 제안했으나,
-- 실측(2026-09-01, 물건 4,960 × 폴리곤 8,311)에서 528물건(10.6%)이 폴리곤 두 장 이상의 안쪽에
-- 있었다 — 원천이 같은 자리의 옛 고시·재고시 폴리곤을 함께 담기 때문이다(겹침쌍 289 중 258이
-- 같은 유형, 겹침율 ~100%). 물건당 한 행을 강제하면 남길 고시를 추측으로 고르게 되므로
-- (zoning_bucket의 추측 배정 금지와 같은 원칙) auction_item_zone과 같은 쌍 테이블을 쓴다.
-- zoning_district 전량 교체 시 CASCADE로 함께 비워진다 — 교체 후 zone_join 재계산이 복구다.
CREATE TABLE IF NOT EXISTS auction_item_zoning (
    auction_item_id    BIGINT NOT NULL REFERENCES auction_item (id) ON DELETE CASCADE,
    zoning_district_id BIGINT NOT NULL REFERENCES zoning_district (id) ON DELETE CASCADE,
    computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auction_item_id, zoning_district_id)
);

CREATE INDEX IF NOT EXISTS auction_item_zoning_item_idx ON auction_item_zoning (auction_item_id);

COMMENT ON TABLE auction_item_zoning IS
    '물건×용도지역. ST_Intersects 쌍 테이블 — 원천에 같은 자리 재고시 폴리곤이 겹쳐 있어(실측 다중 매치 10.6%) 물건당 한 행이 성립하지 않는다';
