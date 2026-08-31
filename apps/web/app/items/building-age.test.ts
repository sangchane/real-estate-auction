// 노후도 문구 — 분자·분모·기준연월 병기, 분모 0 처리, 결측 병기, 금칙어
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DongBuildingAge } from './building-age';
import { buildingAgeSummary, buildingAgeUnknownNote } from './building-age';

function age(over: Partial<DongBuildingAge> = {}): DongBuildingAge {
  return {
    bjdCode: '11110101',
    dongName: '청운동',
    baseYm: '2026-08',
    totalCount: 1240,
    unknownAprCount: 31,
    over20Count: 812,
    over30Count: 496,
    over20RatioPct: 65.5,
    over30RatioPct: 40,
    ...over,
  };
}

test('본문은 분자·분모·기준연월을 함께, 30년·20년을 병기한다 (기획 12 §1.4)', () => {
  assert.equal(
    buildingAgeSummary(age()),
    '청운동 건물 1,240동 중 지은 지 30년 넘은 건물은 496동(40.0%) · ' +
      '20년 넘은 건물은 812동(65.5%) · 건축물대장 2026-08 기준',
  );
});

test('분모 0이면 비율을 내지 않는다 — 0%는 "노후 건물 없음"으로 읽힌다 (엣지 C-2)', () => {
  const text = buildingAgeSummary(
    age({ totalCount: 0, over20Count: 0, over30Count: 0, over20RatioPct: null, over30RatioPct: null }),
  );

  assert.equal(text, '청운동은 집계할 건물이 없어요 · 건축물대장 2026-08 기준');
  assert.ok(!text.includes('%'));
});

test('동 이름이 없으면 "이 동"으로 말한다 — 이름을 지어내지 않는다', () => {
  assert.ok(buildingAgeSummary(age({ dongName: null })).startsWith('이 동 건물'));
});

test('결측이 있으면 분모에서 뺀 수를 병기한다 (엣지 C-3)', () => {
  assert.equal(buildingAgeUnknownNote(age()), '사용승인일 미상 31동은 계산에서 뺐어요');
  assert.equal(buildingAgeUnknownNote(age({ unknownAprCount: 0 })), null);
});

test('금칙어 — 노후도의 좋고 나쁨을 말하지 않는다 (D-011)', () => {
  // 저장소 선례(rights-checklist.test.ts)와 같은 형식의 금칙어 검사
  const forbidden = ['추천', '안전', '유망', '유리', '기회', '수익', '투자하', '괜찮', '좋은', '패스', '권장', '위험', '나쁜'];
  const texts = [
    buildingAgeSummary(age()),
    buildingAgeSummary(age({ totalCount: 0, over30RatioPct: null, over20RatioPct: null })),
    buildingAgeUnknownNote(age()) ?? '',
  ];
  for (const text of texts) {
    for (const word of forbidden) {
      assert.ok(!text.includes(word), `금칙어 "${word}"가 들어갔다: ${text}`);
    }
  }
});
