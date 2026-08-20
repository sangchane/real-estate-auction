-- 점유자 표를 어느 경로로 읽었는지 남긴다 (WP-11 §4-30·§4-31).
--
-- 왜 필요한가: 표를 두 경로로 읽는다.
--   PDF_CELLS  - PDF의 표 구조(괘선). 병합셀이 있어 행·사람을 정확히 가른다.
--   TEXT_LAYER - 법원 뷰어의 텍스트 레이어. 괘선이 없어 "한 이름이 두 줄로 감싸인 것"과
--                "짧은 이름 둘이 이웃한 것"을 원리적으로 못 가른다.
-- 두 경로의 결과는 품질이 다르므로 섞어서 통계를 내면 안 된다. H3 같은 역채점은 경로를
-- 갈라서 봐야 한다.
--
-- 재수집의 자기제한 장치이기도 하다. 열람 창이 열린 명세서를 PDF로 다시 받을 때, 이 값이
-- 'PDF_CELLS'인 것은 건너뛴다 — 없으면 매 회차가 같은 문서를 다시 받아 법원에 요청이 쌓인다.
-- 실측(2026-08-20): 열람 창이 열린 명세서가 1,112건이라 상한 없이 돌리면 한 회차에 6,672요청이
-- 나간다. 법원은 요청이 쌓이면 403이 아니라 **빈 응답**으로 조용히 degrade한다 (§4-3).
--
-- NULL 은 이 마이그레이션 배포 이전에 스캔한 행이다. 그 행들은 전부 TEXT_LAYER 로 읽혔지만,
-- 소급해서 채우지 않는다 — 014·016 이 세운 "옛 행은 모른다로 남긴다" 관례를 따른다.
-- 구분이 필요하면 tenant_scanned_at 과 이 마이그레이션 배포 시각을 비교한다.
ALTER TABLE auction_item_notice
    ADD COLUMN IF NOT EXISTS tenant_source TEXT;

COMMENT ON COLUMN auction_item_notice.tenant_source IS
    '점유자 표를 읽은 경로. PDF_CELLS=PDF 괘선(병합셀 사용), TEXT_LAYER=텍스트 레이어 좌표 추측. NULL=018 이전 스캔';

-- 재수집 대상 조회는 "PDF로 아직 안 읽은 명세서"를 훑으므로 부분 인덱스가 맞다 (012 선례와 같은 형식).
CREATE INDEX IF NOT EXISTS auction_item_notice_not_pdf_idx
    ON auction_item_notice (auction_item_id)
    WHERE tenant_source IS DISTINCT FROM 'PDF_CELLS';
