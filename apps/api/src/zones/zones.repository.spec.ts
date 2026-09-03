import {
  ZonesRepository,
  clipBboxFor,
  ratioPct,
  simplifyToleranceFor,
  zoningSimplifyToleranceFor,
} from './zones.repository';

const SEOUL_WIDE = { minLng: 126.76, minLat: 37.42, maxLng: 127.19, maxLat: 37.7 };
const BLOCK = { minLng: 126.977, minLat: 37.565, maxLng: 126.985, maxLat: 37.571 };

function createMockPool(rows: unknown[]) {
  return { query: jest.fn().mockResolvedValue({ rows }) };
}

function zoneRow(overrides: Record<string, unknown> = {}) {
  return {
    zoneId: '12',
    zoneName: '한남3구역',
    businessKind: '재개발',
    sigungu: '11170',
    geometry: '{"type":"MultiPolygon","coordinates":[[[[126.99,37.53],[127.0,37.53],[126.99,37.54],[126.99,37.53]]]]}',
    itemCount: '3',
    ...overrides,
  };
}

describe('simplifyToleranceFor', () => {
  it('넓게 볼수록 허용오차가 커진다 — 원본은 그대로 두고 조회 때만 단순화한다 (설계 04)', () => {
    expect(simplifyToleranceFor(SEOUL_WIDE)).toBeGreaterThan(simplifyToleranceFor(BLOCK));
  });

  it('허용오차는 설계 04 사다리의 양 끝값 안에 갇힌다', () => {
    const huge = simplifyToleranceFor({ minLng: 120, minLat: 30, maxLng: 132, maxLat: 40 });
    const tiny = simplifyToleranceFor({
      minLng: 126.9788,
      minLat: 37.5665,
      maxLng: 126.979,
      maxLat: 37.5667,
    });

    expect(huge).toBe(0.0005);
    expect(tiny).toBe(0.00005);
  });

  it('가로가 좁고 세로가 긴 뷰포트는 긴 변을 기준으로 삼는다', () => {
    const tall = { minLng: 126.98, minLat: 37.4, maxLng: 126.99, maxLat: 37.7 };
    const wide = { minLng: 126.8, minLat: 37.56, maxLng: 127.1, maxLat: 37.57 };

    expect(simplifyToleranceFor(tall)).toBeCloseTo(simplifyToleranceFor(wide), 12);
  });
});

describe('ZonesRepository', () => {
  it('bbox·retired_at·단순화·물건 수를 한 쿼리로 조립한다', async () => {
    const pool = createMockPool([]);
    const repository = new ZonesRepository(pool as never);

    await repository.findZonesInBbox(BLOCK, 1000);

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM redevelopment_zone');
    expect(sql).toContain('z.retired_at IS NULL');
    expect(sql).toContain('ST_Intersects');
    expect(sql).toContain('ST_MakeEnvelope($1, $2, $3, $4, 4326)');
    expect(sql).toContain('ST_SimplifyPreserveTopology');
    // 좌표 정밀도는 6자리로 고정한다 — 기본값 9자리는 응답 크기를 키우기만 한다 (설계 08 m-14)
    expect(sql).toMatch(/ST_AsGeoJSON\(.*\$5\), 6\)/);
    expect(sql).toContain('FROM auction_item_zone aiz');
    expect(sql).toContain('LIMIT $6');
    expect(params.slice(0, 5)).toEqual([
      BLOCK.minLng,
      BLOCK.minLat,
      BLOCK.maxLng,
      BLOCK.maxLat,
      simplifyToleranceFor(BLOCK),
    ]);
  });

  it('상한을 넘겼는지 알려고 limit+1을 읽고, 넘치면 잘라 truncated를 세운다', async () => {
    const pool = createMockPool([zoneRow({ zoneId: '1' }), zoneRow({ zoneId: '2' })]);
    const repository = new ZonesRepository(pool as never);

    const result = await repository.findZonesInBbox(BLOCK, 1);

    expect((pool.query.mock.calls[0] as [string, unknown[]])[1][5]).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.features).toHaveLength(1);
  });

  it('상한 안이면 truncated는 false다', async () => {
    const pool = createMockPool([zoneRow()]);
    const repository = new ZonesRepository(pool as never);

    const result = await repository.findZonesInBbox(BLOCK, 1000);

    expect(result.truncated).toBe(false);
  });

  it('행을 GeoJSON Feature로 바꾸고 BIGINT 문자열을 숫자로 만든다', async () => {
    const pool = createMockPool([zoneRow()]);
    const repository = new ZonesRepository(pool as never);

    const result = await repository.findZonesInBbox(BLOCK, 1000);

    expect(result.type).toBe('FeatureCollection');
    expect(result.features).toEqual([
      {
        type: 'Feature',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[[[126.99, 37.53], [127.0, 37.53], [126.99, 37.54], [126.99, 37.53]]]],
        },
        properties: {
          zoneId: 12,
          // zoneName이 있으므로 승격하지 않는다
          displayName: '한남3구역',
          namePromoted: false,
          zoneName: '한남3구역',
          businessKind: '재개발',
          sigungu: '11170',
          itemCount: 3,
        },
      },
    ]);
  });

  it('구역명이 비어 있어도 null로 내려보낸다 — 원천에 이름 없는 행이 실제로 있다', async () => {
    const pool = createMockPool([zoneRow({ zoneName: null, itemCount: '0' })]);
    const repository = new ZonesRepository(pool as never);

    const result = await repository.findZonesInBbox(BLOCK, 1000);

    expect(result.features[0]?.properties.zoneName).toBeNull();
    expect(result.features[0]?.properties.itemCount).toBe(0);
  });
});

// z14 뷰포트 규모(폭 0.12°) — 사다리 양 끝 클램프에 걸리지 않는 구간이라 divisor 차이가 드러난다.
const Z14 = { minLng: 126.9184, minLat: 37.5346, maxLng: 127.0384, maxLat: 37.6116 };

describe('zoningSimplifyToleranceFor', () => {
  it('같은 뷰포트에서 정비구역의 두 배로 굵다 — 채움 레이어라 윤곽 1~2px 대신 응답 크기를 산다', () => {
    expect(zoningSimplifyToleranceFor(Z14)).toBeCloseTo(simplifyToleranceFor(Z14) * 2, 12);
  });

  it('허용오차는 정비구역과 같은 사다리 양 끝값 안에 갇힌다', () => {
    const huge = zoningSimplifyToleranceFor({ minLng: 120, minLat: 30, maxLng: 132, maxLat: 40 });
    const tiny = zoningSimplifyToleranceFor(BLOCK);

    expect(huge).toBe(0.0005);
    expect(tiny).toBe(0.00005);
  });
});

describe('clipBboxFor', () => {
  it('긴 변의 10%만큼 사방으로 넓힌다 — 절단이 만든 인공 경계선이 화면 밖에 놓인다', () => {
    const clip = clipBboxFor(Z14);
    const pad = 0.12 * 0.1;

    expect(clip.minLng).toBeCloseTo(Z14.minLng - pad, 12);
    expect(clip.minLat).toBeCloseTo(Z14.minLat - pad, 12);
    expect(clip.maxLng).toBeCloseTo(Z14.maxLng + pad, 12);
    expect(clip.maxLat).toBeCloseTo(Z14.maxLat + pad, 12);
  });
});

function zoningRow(overrides: Record<string, unknown> = {}) {
  return {
    zoningId: '812',
    zoningBucket: 'RES_GENERAL_2',
    zoneNameRaw: '제2종일반주거지역(7층이하)',
    sclasCl: 'UQA124',
    mlsfcCl: null,
    baseYm: '2026-02',
    geometry:
      '{"type":"Polygon","coordinates":[[[126.99,37.53],[127.0,37.53],[126.99,37.54],[126.99,37.53]]]}',
    ...overrides,
  };
}

describe('ZonesRepository 용도지역 bbox', () => {
  it('bbox·클립·단순화·상한을 한 쿼리로 조립한다', async () => {
    const pool = createMockPool([]);
    const repository = new ZonesRepository(pool as never);

    await repository.findZoningInBbox(Z14, 2000);

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM zoning_district');
    expect(sql).toContain('z.geom IS NOT NULL');
    expect(sql).toContain('ST_Intersects');
    expect(sql).toContain('ST_MakeEnvelope($1, $2, $3, $4, 4326)');
    // 클립 상자는 요청 bbox($1~$4)가 아니라 패딩 상자($6~$9)다 — 뷰포트 경계에서 잘리면 인공 경계가 보인다
    expect(sql).toContain('ST_ClipByBox2D(z.geom, ST_MakeEnvelope($6, $7, $8, $9, 4326))');
    expect(sql).toContain('ST_SimplifyPreserveTopology');
    // 좌표 정밀도는 6자리 고정 — 정비구역과 같은 규약 (설계 08 m-14)
    expect(sql).toContain('$5), 6)');
    expect(sql).toContain('LIMIT $10');

    const clip = clipBboxFor(Z14);
    expect(params).toEqual([
      Z14.minLng,
      Z14.minLat,
      Z14.maxLng,
      Z14.maxLat,
      zoningSimplifyToleranceFor(Z14),
      clip.minLng,
      clip.minLat,
      clip.maxLng,
      clip.maxLat,
      2001,
    ]);
  });

  it('상한을 넘겼는지 알려고 limit+1을 읽고, 넘치면 잘라 truncated를 세운다', async () => {
    const pool = createMockPool([zoningRow({ zoningId: '1' }), zoningRow({ zoningId: '2' })]);
    const repository = new ZonesRepository(pool as never);

    const result = await repository.findZoningInBbox(Z14, 1);

    expect(result.truncated).toBe(true);
    expect(result.features).toHaveLength(1);
  });

  it('행을 Feature로 바꾸고 버킷(채색 키)과 원문 명칭·코드를 함께 싣는다', async () => {
    const pool = createMockPool([zoningRow()]);
    const repository = new ZonesRepository(pool as never);

    const result = await repository.findZoningInBbox(Z14, 2000);

    expect(result.type).toBe('FeatureCollection');
    expect(result.truncated).toBe(false);
    expect(result.features).toEqual([
      {
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[126.99, 37.53], [127.0, 37.53], [126.99, 37.54], [126.99, 37.53]]],
        },
        properties: {
          zoningId: 812,
          zoningBucket: 'RES_GENERAL_2',
          zoneNameRaw: '제2종일반주거지역(7층이하)',
          sclasCl: 'UQA124',
          mlsfcCl: null,
        },
      },
    ]);
  });

  it('미분류 행은 버킷 null 그대로다 — 가까운 버킷으로 추측 배정하지 않는다 (기획 12 §2.4)', async () => {
    const pool = createMockPool([
      zoningRow({ zoningBucket: null, zoneNameRaw: '기타 도시지역', sclasCl: null, mlsfcCl: null }),
    ]);
    const repository = new ZonesRepository(pool as never);

    const feature = (await repository.findZoningInBbox(Z14, 2000)).features[0];
    // 피처가 없으면 아래 단언이 통째로 건너뛰어져 초록불이 거짓말을 한다
    expect(feature).toBeDefined();
    const { properties } = feature as NonNullable<typeof feature>;

    expect(properties.zoningBucket).toBeNull();
    // 화면이 카드에 낼 원문은 그대로 살아 있어야 한다
    expect(properties.zoneNameRaw).toBe('기타 도시지역');
  });

  it('기준연월은 컬렉션에 한 번만 싣고, 피처가 없으면 null이다', async () => {
    const repository = new ZonesRepository(createMockPool([zoningRow()]) as never);
    const empty = new ZonesRepository(createMockPool([]) as never);

    expect((await repository.findZoningInBbox(Z14, 2000)).baseYm).toBe('2026-02');
    expect((await empty.findZoningInBbox(Z14, 2000)).baseYm).toBeNull();
  });
});

describe('ZonesRepository 물건 용도지역', () => {
  it('물건키로 사전계산 조인을 타고, 재고시 겹침(여러 행)을 전부 내린다', async () => {
    const rowA = {
      zoningId: '812',
      zoningBucket: 'RES_GENERAL_2',
      zoneNameRaw: '제2종일반주거지역(7층이하)',
      sclasCl: 'UQA124',
      mlsfcCl: null,
      baseYm: '2026-02',
    };
    const rowB = { ...rowA, zoningId: '4102', zoningBucket: null, zoneNameRaw: '기타 도시지역' };
    const pool = createMockPool([rowA, rowB]);
    const repository = new ZonesRepository(pool as never);

    const districts = await repository.findZoningForItem('B000210', '2024타경1234', '1');

    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM auction_item ai');
    expect(sql).toContain('JOIN auction_item_zoning link');
    expect(sql).toContain('JOIN zoning_district zd');
    expect(params).toEqual(['B000210', '2024타경1234', '1']);
    expect(districts).toEqual([
      { ...rowA, zoningId: 812 },
      { ...rowB, zoningId: 4102 },
    ]);
  });

  it('매칭이 없으면 빈 배열 — 404 판정은 컨트롤러의 몫이다', async () => {
    const repository = new ZonesRepository(createMockPool([]) as never);

    expect(await repository.findZoningForItem('B000210', '2024타경1234', '1')).toEqual([]);
  });
});

describe('ZonesRepository 구역명 승격', () => {
  it('zoneName이 비면 businessKind의 구역명을 표시 이름으로 올린다', async () => {
    // 원천 실측: ALIAS가 776건 중 563건 비어 있고 REMARK에 구역명이 들어 있는 경우가 있다
    const pool = createMockPool([
      zoneRow({ zoneName: null, businessKind: '남대문 도시정비형 재개발구역' }),
    ]);
    const repository = new ZonesRepository(pool as never);

    const feature = (await repository.findZonesInBbox(BLOCK, 1000)).features[0];
    // 피처가 없으면 아래 단언이 통째로 건너뛰어져 초록불이 거짓말을 한다
    expect(feature).toBeDefined();
    const { properties } = feature as NonNullable<typeof feature>;

    expect(properties.displayName).toBe('남대문 도시정비형 재개발구역');
    expect(properties.namePromoted).toBe(true);
    // 원본은 그대로 함께 내린다 — 승격이 틀렸을 때 근거를 볼 수 있어야 한다
    expect(properties.zoneName).toBeNull();
  });

  it('사업 유형 어휘뿐이면 올리지 않는다 — 여러 구역이 같은 이름이 되면 이름 구실을 못 한다', async () => {
    const pool = createMockPool([zoneRow({ zoneName: null, businessKind: '도시환경정비구역' })]);
    const repository = new ZonesRepository(pool as never);

    const feature = (await repository.findZonesInBbox(BLOCK, 1000)).features[0];
    // 피처가 없으면 아래 단언이 통째로 건너뛰어져 초록불이 거짓말을 한다
    expect(feature).toBeDefined();
    const { properties } = feature as NonNullable<typeof feature>;

    expect(properties.displayName).toBeNull();
    expect(properties.businessKind).toBe('도시환경정비구역');
  });
});

describe('ratioPct', () => {
  it('소수점 1자리 %로 반올림한다 — 계산은 API 한 곳 (05 반올림 정책)', () => {
    expect(ratioPct(496, 1240)).toBe(40);
    expect(ratioPct(812, 1240)).toBe(65.5);
    expect(ratioPct(177, 314)).toBe(56.4);
  });

  it('분모 0이면 null — 0%로 내리면 "노후 건물 없음"이라는 허위 사실이 된다 (엣지 C-2)', () => {
    expect(ratioPct(0, 0)).toBeNull();
  });
});

describe('ZonesRepository 노후도', () => {
  const ageRow = {
    bjdCode: '11110101',
    dongName: '청운동',
    baseYm: '2026-08',
    totalCount: 314,
    unknownAprCount: 43,
    over20Count: 237,
    over30Count: 177,
  };

  it('물건키 → 동 집계 한 행에 비율을 붙여 내린다', async () => {
    const pool = createMockPool([ageRow]);
    const repository = new ZonesRepository(pool as never);

    const dto = await repository.findBuildingAgeForItem('B000210', '2024타경1234', '1');

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('building_age_dong'), [
      'B000210',
      '2024타경1234',
      '1',
    ]);
    expect(dto).toEqual({ ...ageRow, over20RatioPct: 75.5, over30RatioPct: 56.4 });
  });

  it('동 매칭이나 집계가 없으면 null — 섹션을 그리지 않는 것이 정답이지 0%가 아니다', async () => {
    const pool = createMockPool([]);
    const repository = new ZonesRepository(pool as never);

    expect(await repository.findBuildingAgeForItem('B000210', '2024타경1234', '1')).toBeNull();
  });

  it('분모 0인 동은 비율이 null인 채로 내려간다 — 화면이 "집계할 건물이 없어요"로 말한다', async () => {
    const pool = createMockPool([
      { ...ageRow, totalCount: 0, over20Count: 0, over30Count: 0, unknownAprCount: 12 },
    ]);
    const repository = new ZonesRepository(pool as never);

    const dto = await repository.findBuildingAgeForItem('B000210', '2024타경1234', '1');

    expect(dto?.over20RatioPct).toBeNull();
    expect(dto?.over30RatioPct).toBeNull();
  });
});
