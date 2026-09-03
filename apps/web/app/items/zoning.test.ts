// 용도지역 문구 — 원문 명칭 우선, 겹침 안내, 출처 고지, 금칙어
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ItemZoningDistrict } from './zoning';
import {
  dedupeZoning,
  ZONING_BUCKET_LABEL,
  zoningDisplayName,
  zoningOverlapNote,
  zoningSourceNote,
} from './zoning';

function district(over: Partial<ItemZoningDistrict> = {}): ItemZoningDistrict {
  return {
    zoningId: 1,
    zoningBucket: 'RES_GENERAL_2',
    zoneNameRaw: '제2종일반주거지역',
    sclasCl: 'UQA122',
    mlsfcCl: 'UQA120',
    baseYm: '2026-02',
    ...over,
  };
}

test('표시 이름은 원문 명칭 그대로다 — 고시 세부를 버킷 이름표로 바꾸지 않는다', () => {
  const name = zoningDisplayName(district({ zoneNameRaw: '제2종일반주거지역(7층이하)' }));
  assert.equal(name, '제2종일반주거지역(7층이하)');
  // 같은 버킷이지만 이름표는 "(7층이하)"를 담지 못한다 — 원문이 이겨야 하는 이유다.
  assert.equal(ZONING_BUCKET_LABEL.RES_GENERAL_2, '제2종일반주거');
});

test('명칭이 비면 코드 원문으로, 코드도 없으면 없다고 적는다', () => {
  assert.equal(zoningDisplayName(district({ zoneNameRaw: null })), '코드 UQA122');
  assert.equal(
    zoningDisplayName(district({ zoneNameRaw: null, sclasCl: null })),
    '코드 UQA120',
    '소분류가 비면 중분류 원문을 쓴다 — 원천이 소분류를 비워 두는 행이 실측 25%다',
  );
  assert.equal(
    zoningDisplayName(district({ zoneNameRaw: null, sclasCl: null, mlsfcCl: null })),
    '명칭 정보 없음',
  );
});

test('보여줄 값이 같은 건은 한 줄로 접는다 — 같은 문장을 일곱 번 적지 않는다', () => {
  // 실측: 한 물건이 "제2종일반주거지역" 7행이었다(2026-09-03).
  const same = [district(), district({ zoningId: 2 }), district({ zoningId: 3 })];
  assert.equal(dedupeZoning(same).length, 1);
  assert.equal(dedupeZoning(same)[0]?.zoningId, 1, '첫 건을 남긴다');
});

test('값이 실제로 다르면 접지 않는다 — 한 건을 고르는 순간 추측이 된다', () => {
  const mixed = [
    district(),
    district({ zoningId: 2, zoneNameRaw: '제3종일반주거지역', sclasCl: 'UQA123' }),
  ];
  assert.equal(dedupeZoning(mixed).length, 2);
});

test('겹침 안내는 접은 뒤 2건 이상일 때만 뜬다', () => {
  assert.equal(zoningOverlapNote([district()]), null);
  assert.equal(
    zoningOverlapNote([district(), district({ zoningId: 2 })]),
    null,
    '같은 값이 두 폴리곤에 있는 것은 사용자에게 겹침이 아니다',
  );
  assert.equal(
    zoningOverlapNote([
      district(),
      district({ zoningId: 2, zoneNameRaw: '제3종일반주거지역', sclasCl: 'UQA123' }),
    ]),
    '이 자리에는 고시가 다른 용도지역 2건이 겹쳐 있어요',
  );
});

test('출처 고지는 기준연월과 "법적 효력 없음"을 함께 적는다', () => {
  const note = zoningSourceNote([district().baseYm]);
  assert.ok(note.includes('2026-02'), note);
  assert.ok(note.includes('법적 효력이 없는 참고자료'), note);
});

test('기준연월이 섞이면 모두 적는다 — 하나로 합치면 없는 사실이 된다', () => {
  const note = zoningSourceNote(['2026-02', '2026-08']);
  assert.ok(note.includes('2026-02·2026-08'), note);
});

test('금칙어 — 용도지역의 좋고 나쁨을 말하지 않는다 (D-011)', () => {
  // 저장소 선례(building-age.test.ts)와 같은 형식의 금칙어 검사. 용도지역은 특히 "몇 종이 좋다"는
  // 통념이 강해 문구가 그쪽으로 새기 쉽다 — 종은 법정 순서일 뿐이다.
  const forbidden = ['추천', '안전', '유망', '유리', '기회', '수익', '투자하', '괜찮', '좋은', '패스', '권장', '위험', '나쁜'];
  const districts = [district(), district({ zoningId: 2, baseYm: '2026-08' })];
  const texts = [
    zoningDisplayName(district()),
    zoningOverlapNote(districts) ?? '',
    zoningSourceNote(districts.map((d) => d.baseYm)),
    ...Object.values(ZONING_BUCKET_LABEL),
  ];
  for (const text of texts) {
    for (const word of forbidden) {
      assert.ok(!text.includes(word), `금칙어 "${word}"가 들어갔다: ${text}`);
    }
  }
});
