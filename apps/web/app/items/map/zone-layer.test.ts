import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseZoneCollection, zoneRings, ZONE_MIN_ZOOM } from './zone-layer';

function collection(features: unknown[], truncated = false): unknown {
  return { type: 'FeatureCollection', truncated, features };
}

function properties(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zoneId: 1,
    zoneName: '흑석11구역',
    businessKind: '재개발',
    sigungu: '서울특별시 동작구',
    itemCount: 3,
    ...overrides,
  };
}

const SQUARE = [
  [
    [126.9, 37.5],
    [126.91, 37.5],
    [126.91, 37.51],
    [126.9, 37.51],
    [126.9, 37.5],
  ],
];

test('Polygon은 바깥 경계와 구멍을 모두 링으로 낸다', () => {
  // 구멍도 경계다 — 채움 없이 윤곽선만 그리므로 안쪽 링을 빼면 실제로 있는 선이 사라진다.
  const hole = [
    [126.902, 37.502],
    [126.904, 37.502],
    [126.904, 37.504],
    [126.902, 37.502],
  ];
  const rings = zoneRings({ type: 'Polygon', coordinates: [...SQUARE, hole] });

  assert.equal(rings.length, 2);
  assert.deepEqual(rings[0]?.[0], [126.9, 37.5]);
  assert.equal(rings[1]?.length, 4);
});

test('MultiPolygon은 폴리곤별 링을 한 줄로 펼친다', () => {
  const rings = zoneRings({ type: 'MultiPolygon', coordinates: [SQUARE, SQUARE] });

  assert.equal(rings.length, 2);
});

test('rep_point만 있는 대상지(Point)는 링이 없다', () => {
  // 마이그레이션 021: 대상지(후보)는 폴리곤 없이 rep_point만 들어온다. 점은 윤곽선이 될 수 없다.
  assert.deepEqual(zoneRings({ type: 'Point', coordinates: [126.9, 37.5] }), []);
});

test('좌표가 깨진 링과 점 3개 미만인 링은 버린다', () => {
  const broken = zoneRings({
    type: 'Polygon',
    coordinates: [
      [
        [126.9, 37.5],
        ['126.91', 37.5],
        [126.91, 37.51],
      ],
    ],
  });
  assert.deepEqual(broken, []);

  const tooShort = zoneRings({
    type: 'Polygon',
    coordinates: [
      [
        [126.9, 37.5],
        [126.91, 37.5],
      ],
    ],
  });
  assert.deepEqual(tooShort, []);
});

test('지오메트리가 아예 없어도 예외를 던지지 않는다', () => {
  assert.deepEqual(zoneRings(undefined), []);
  assert.deepEqual(zoneRings({ type: 'Polygon' }), []);
});

test('parseZoneCollection은 FeatureCollection 껍데기가 아니면 끊는다', () => {
  // 잘못된 응답을 통과시키면 화면이 그것을 "이 동네에 구역이 없다"는 사실로 읽는다 (zones.controller와 같은 이유).
  assert.throws(() => parseZoneCollection([]));
  assert.throws(() => parseZoneCollection({ type: 'Feature', features: [] }));
  assert.throws(() => parseZoneCollection({ type: 'FeatureCollection' }));
});

test('parseZoneCollection은 속성과 링을 모두 갖춘 피처만 남긴다', () => {
  const parsed = parseZoneCollection(
    collection([
      { type: 'Feature', properties: properties(), geometry: { type: 'Polygon', coordinates: SQUARE } },
      // 그릴 링이 없는 구역 — 폴리곤 풀에 빈 자리를 만들지 않게 여기서 뺀다
      { type: 'Feature', properties: properties({ zoneId: 2 }), geometry: { type: 'Point', coordinates: [1, 2] } },
      // 물건 수가 숫자가 아니면 화면이 "N건"을 만들 수 없다
      { type: 'Feature', properties: properties({ itemCount: '3' }), geometry: { type: 'Polygon', coordinates: SQUARE } },
    ]),
  );

  assert.equal(parsed.features.length, 1);
  assert.equal(parsed.features[0]?.properties.zoneId, 1);
  assert.equal(parsed.features[0]?.properties.zoneName, '흑석11구역');
  assert.equal(parsed.features[0]?.rings.length, 1);
});

test('parseZoneCollection은 빠진 이름·사업종류를 null로 둔다', () => {
  const parsed = parseZoneCollection(
    collection([
      {
        type: 'Feature',
        properties: { zoneId: 7, zoneName: null, businessKind: null, sigungu: null, itemCount: 0 },
        geometry: { type: 'Polygon', coordinates: SQUARE },
      },
    ]),
  );

  assert.equal(parsed.features[0]?.properties.zoneName, null);
  assert.equal(parsed.features[0]?.properties.businessKind, null);
  assert.equal(parsed.features[0]?.properties.itemCount, 0);
});

test('parseZoneCollection은 상한에 걸려 잘렸다는 사실을 그대로 옮긴다', () => {
  // 잘린 것을 숨기면 화면이 "구역 없음"과 구분하지 못한다 (zone-feature.dto.ts truncated).
  assert.equal(parseZoneCollection(collection([], true)).truncated, true);
  assert.equal(parseZoneCollection(collection([])).truncated, false);
});

test('정비구역 줌 임계값은 개별 마커 전환 줌보다 낮다', () => {
  // 구역은 마커보다 큰 도형이라 마커가 개별로 갈라지기 전(z15)부터 읽힌다.
  // 임계값이 15 이상이면 클러스터 화면에서는 구역을 아예 볼 수 없다.
  assert.ok(ZONE_MIN_ZOOM < 15);
  assert.ok(ZONE_MIN_ZOOM >= 13);
});

test('표시 이름과 승격 여부를 함께 읽는다', () => {
  // API가 원천의 zoneName/businessKind를 보고 표시 이름을 골라 내려준다.
  // 화면은 그 판단을 다시 하지 않고 받은 값을 쓴다 — 두 곳에서 규칙이 갈라지면 안 된다.
  const parsed = parseZoneCollection({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          zoneId: 9,
          displayName: '남대문 도시정비형 재개발구역',
          namePromoted: true,
          zoneName: null,
          businessKind: '남대문 도시정비형 재개발구역',
          sigungu: '11140',
          itemCount: 2,
        },
        geometry: { type: 'Polygon', coordinates: SQUARE },
      },
    ],
  });

  assert.equal(parsed.features[0]?.properties.displayName, '남대문 도시정비형 재개발구역');
  assert.equal(parsed.features[0]?.properties.namePromoted, true);
  // 원본도 그대로 남는다 — 승격이 틀렸을 때 근거를 볼 수 있어야 한다
  assert.equal(parsed.features[0]?.properties.zoneName, null);
});

test('승격 정보가 없으면 이름 없음으로 읽는다 — 지어내지 않는다', () => {
  const parsed = parseZoneCollection({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { zoneId: 7, zoneName: null, businessKind: '도시환경정비구역', sigungu: null, itemCount: 0 },
        geometry: { type: 'Polygon', coordinates: SQUARE },
      },
    ],
  });

  assert.equal(parsed.features[0]?.properties.displayName, null);
  assert.equal(parsed.features[0]?.properties.namePromoted, false);
});
