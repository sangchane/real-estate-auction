// 용도지역 레이어 순수 로직 — 응답 검증, 미분류·미지 버킷의 중립 렌더, 범례 순서
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { colors } from '@auction/design-tokens';
import {
  parseZoningCollection,
  pointInRings,
  zoningAt,
  zoningFillColor,
  ZONING_LEGEND,
  ZONING_MIN_ZOOM,
} from './zoning-layer';

function square(): unknown {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [126.97, 37.56],
        [126.98, 37.56],
        [126.98, 37.57],
        [126.97, 37.56],
      ],
    ],
  };
}

function feature(properties: Record<string, unknown> = {}): unknown {
  return {
    type: 'Feature',
    geometry: square(),
    properties: {
      zoningId: 1,
      zoningBucket: 'RES_GENERAL_2',
      zoneNameRaw: '제2종일반주거지역',
      sclasCl: 'UQA122',
      mlsfcCl: null,
      ...properties,
    },
  };
}

function collection(features: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { type: 'FeatureCollection', truncated: false, baseYm: '2026-02', features, ...extra };
}

test('FeatureCollection이 아니면 예외로 끊는다', () => {
  assert.throws(() => parseZoningCollection({ type: 'Feature' }));
  assert.throws(() => parseZoningCollection(null));
});

test('피처 하나가 깨져도 나머지는 살린다 — 레이어를 통째로 비우지 않는다', () => {
  const parsed = parseZoningCollection(
    collection([feature(), { type: 'Feature', geometry: square(), properties: { zoningId: 'x' } }]),
  );
  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0]?.properties.zoningId, 1);
});

test('그릴 링이 없는 피처는 뺀다', () => {
  const noRing = { type: 'Feature', geometry: { type: 'Point', coordinates: [126.97, 37.56] }, properties: { zoningId: 2 } };
  assert.equal(parseZoningCollection(collection([noRing])).features.length, 0);
});

test('truncated·baseYm은 응답 그대로 옮긴다 — 화면이 "용도지역 없음"과 구분해야 한다', () => {
  const parsed = parseZoningCollection(collection([feature()], { truncated: true }));
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.baseYm, '2026-02');
  assert.equal(parseZoningCollection(collection([], { baseYm: null })).baseYm, null);
});

test('원문 코드·명칭은 손대지 않고 그대로 싣는다', () => {
  const parsed = parseZoningCollection(
    collection([feature({ zoneNameRaw: '제2종일반주거지역(7층이하)', zoningBucket: null })]),
  );
  assert.equal(parsed.features[0]?.properties.zoneNameRaw, '제2종일반주거지역(7층이하)');
  assert.equal(parsed.features[0]?.properties.zoningBucket, null);
});

test('채색 버킷 5개는 램프 순서대로 색을 받는다', () => {
  assert.equal(zoningFillColor('RES_EXCLUSIVE'), colors.mapSeq1);
  assert.equal(zoningFillColor('RES_GENERAL_1'), colors.mapSeq2);
  assert.equal(zoningFillColor('RES_GENERAL_2'), colors.mapSeq3);
  assert.equal(zoningFillColor('RES_GENERAL_3'), colors.mapSeq4);
  assert.equal(zoningFillColor('RES_SEMI'), colors.mapSeq5);
});

test('미분류·그 밖·모르는 버킷은 색을 주지 않는다 (추측 배정 금지)', () => {
  assert.equal(zoningFillColor(null), null);
  assert.equal(zoningFillColor('OTHER'), null);
  // 적재기가 버킷을 늘리는 날에도 화면은 조용히 틀리지 않고 중립으로 남아야 한다.
  assert.equal(zoningFillColor('RES_FUTURE_BUCKET'), null);
});

test('범례는 법정 세분 순서이고 색이 겹치지 않는다', () => {
  assert.deepEqual(
    ZONING_LEGEND.map((entry) => entry.bucket),
    ['RES_EXCLUSIVE', 'RES_GENERAL_1', 'RES_GENERAL_2', 'RES_GENERAL_3', 'RES_SEMI'],
  );
  assert.equal(new Set(ZONING_LEGEND.map((entry) => entry.fill)).size, ZONING_LEGEND.length);
});

test('용도지역은 z14부터만 그린다 — 그 아래는 상한에 걸려 화면이 뚫린다', () => {
  assert.equal(ZONING_MIN_ZOOM, 14);
});

test('점-폴리곤 판정은 안/밖을 가르고 구멍은 밖으로 센다', () => {
  const outer: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  // 구멍(4~6 사각형). 짝홀 규칙에서는 구멍 안의 점이 두 번 교차해 자연히 바깥이 된다.
  const hole: [number, number][] = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
    [4, 4],
  ];
  assert.equal(pointInRings([outer], 5, 5), true);
  assert.equal(pointInRings([outer], 11, 5), false);
  assert.equal(pointInRings([outer, hole], 5, 5), false, '구멍 안은 바깥이다');
  assert.equal(pointInRings([outer, hole], 2, 2), true, '구멍 밖·경계 안은 안쪽이다');
});

test('zoningAt은 그 좌표를 덮는 용도지역을 찾고, 없으면 null이다', () => {
  const parsed = parseZoningCollection(collection([feature()]));
  // square()는 (126.97,37.56)-(126.98,37.57) 삼각형이다.
  assert.equal(zoningAt(parsed.features, 126.975, 37.563)?.properties.zoningId, 1);
  assert.equal(zoningAt(parsed.features, 126.9, 37.5), null);
});
