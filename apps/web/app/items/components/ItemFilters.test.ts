// 목록 필터의 순수 함수 — 주소 쿼리 해석과 API 필터 변환 (컴포넌트 렌더는 이 저장소 선례에 없다)
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFilters, toApiFilter, PRICE_RANGES } from './item-filters';

test('모르는 값은 무시한다 — 손으로 주소를 고쳐도 화면이 깨지지 않게', () => {
  const state = parseFilters({ usage: 'APARTMENT,없는범주', price: '없는구간', sort: '없는정렬' });

  assert.deepEqual(state.categories, ['APARTMENT']);
  assert.equal(state.priceKey, undefined);
  assert.equal(state.sort, 'recent');
});

test('빈 쿼리는 기본 상태가 된다', () => {
  const state = parseFilters({});

  assert.deepEqual(state, { sigungu: undefined, categories: [], priceKey: undefined, sort: 'recent' });
});

test('범주를 용도 원문 목록으로 편다 — API는 범주를 모른다', () => {
  const filter = toApiFilter(parseFilters({ usage: 'MULTI_HOUSE' }));

  // 다세대·연립주택·빌라가 한 범주다 (usage-category의 실측 분포)
  assert.ok(filter.usages);
  assert.ok(filter.usages.includes('다세대'));
  assert.ok(filter.usages.includes('연립주택'));
  assert.ok(filter.usages.includes('빌라'));
});

test('유형을 안 고르면 용도 조건을 보내지 않는다 — 빈 배열이면 목록이 사라진다', () => {
  assert.equal(toApiFilter(parseFilters({})).usages, undefined);
});

test('가격 구간을 최소·최대로 편다', () => {
  const filter = toApiFilter(parseFilters({ price: '1-3e' }));

  assert.equal(filter.minPrice, 100_000_000);
  assert.equal(filter.maxPrice, 300_000_000);
});

test('상한 없는 구간은 최대가를 보내지 않는다 — 없으면 비싼 물건이 어디에도 안 걸린다', () => {
  const filter = toApiFilter(parseFilters({ price: '10e~' }));

  assert.equal(filter.minPrice, 1_000_000_000);
  assert.equal(filter.maxPrice, undefined);
});

test('가격 구간은 빈틈 없이 이어진다 — 사이에 낀 금액이 어디에도 안 걸리면 안 된다', () => {
  const bounded = PRICE_RANGES.filter((range) => 'max' in range);

  for (const range of bounded) {
    const next = PRICE_RANGES.find(
      (candidate) => 'min' in candidate && candidate.min === (range as { max: number }).max,
    );
    assert.ok(next, `${range.label} 위 구간이 이어지지 않는다`);
  }
});
