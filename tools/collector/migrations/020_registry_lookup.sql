-- 등기부 조회 결과를 물건 단위로 보관한다 — 열람 1건에 700원이 실제로 나가기 때문이다 (D-008).
--
-- 왜 DB인가: 커넥터의 캐시(`registry-request-cache.ts`)는 프로세스 메모리의 Map이라 API를
-- 재시작하면 통째로 사라진다. 이미 700원 주고 받은 등기부를 배포할 때마다 다시 사는 구조였다.
-- on-demand 발급의 원가 통제는 "안 받는 것"이 아니라 "한 번 받은 것을 잃지 않는 것"이다.
--
-- **왜 사건이 아니라 물건 단위인가**: 커넥터는 캐시 키를 `${법원사무소코드}:${사건번호}`로
-- 잡고 있었는데, 한 사건에 물건이 여럿인 경우가 3,083건 중 361건(12%)이고 그것들은 주소가
-- 다른 **별개 부동산**이다(예: 2024타경64502 — 1층 10호 / 5층 50호). 사건 키로 캐시하면
-- 2번 물건 화면에 1번 물건의 등기부가 붙는다. 돈을 아끼려다 권리분석이 틀리는 쪽이 훨씬 나쁘다.
--
-- **개인정보**: CODEF 원문에는 소유자·채권자 성명과 **주민등록번호**가 들어 있다. 원문을
-- 저장하지 않고 매핑을 마친 권리 목록(`RegisteredRightDto[]` — 접수일·종류·금액·플래그만)만
-- 남긴다. 주민등록번호 필드는 어떤 스키마에도 만들지 않는다 (D-011a, A-08).
-- 이 선택의 대가는 매퍼가 좋아져도 원문을 다시 못 돌린다는 것인데, 다시 돌리려면 원문을
-- 갖고 있어야 하고 그건 위 규칙과 정면으로 충돌한다.
CREATE TABLE IF NOT EXISTS registry_lookup (
    id                BIGSERIAL PRIMARY KEY,
    auction_item_id   BIGINT NOT NULL REFERENCES auction_item (id) ON DELETE CASCADE,
    registered_rights JSONB  NOT NULL,
    unique_no         TEXT,
    fetched_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (auction_item_id)
);

COMMENT ON TABLE registry_lookup IS
    '등기부 열람 결과(물건 단위). 1건당 700원이 나가므로 재조회 대신 이 표를 먼저 본다';
COMMENT ON COLUMN registry_lookup.registered_rights IS
    '매핑을 마친 등기 권리 목록(RegisteredRightDto[]). CODEF 원문은 성명·주민등록번호를 포함해 저장하지 않는다';
COMMENT ON COLUMN registry_lookup.unique_no IS
    '부동산 고유번호. 다음 조회 때 주소 검색(2-Way 왕복)을 건너뛴다. 주소로 찾은 건은 NULL일 수 있다';
COMMENT ON COLUMN registry_lookup.fetched_at IS
    '열람한 시각. 등기부는 계속 바뀌므로 화면에 이 날짜를 함께 보여준다 — 최신이라고 말하지 않는다';
