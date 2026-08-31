import { ZonesRepository, simplifyToleranceFor } from './zones.repository';

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

describe('ZonesRepository 구역명 승격', () => {
  it('zoneName이 비면 businessKind의 구역명을 표시 이름으로 올린다', async () => {
    // 원천 실측: ALIAS가 776건 중 563건 비어 있고 REMARK에 구역명이 들어 있는 경우가 있다
    const pool = createMockPool([
      zoneRow({ zoneName: null, businessKind: '남대문 도시정비형 재개발구역' }),
    ]);
    const repository = new ZonesRepository(pool as never);

    const { properties } = (await repository.findZonesInBbox(BLOCK, 1000)).features[0]!;

    expect(properties.displayName).toBe('남대문 도시정비형 재개발구역');
    expect(properties.namePromoted).toBe(true);
    // 원본은 그대로 함께 내린다 — 승격이 틀렸을 때 근거를 볼 수 있어야 한다
    expect(properties.zoneName).toBeNull();
  });

  it('사업 유형 어휘뿐이면 올리지 않는다 — 여러 구역이 같은 이름이 되면 이름 구실을 못 한다', async () => {
    const pool = createMockPool([zoneRow({ zoneName: null, businessKind: '도시환경정비구역' })]);
    const repository = new ZonesRepository(pool as never);

    const { properties } = (await repository.findZonesInBbox(BLOCK, 1000)).features[0]!;

    expect(properties.displayName).toBeNull();
    expect(properties.businessKind).toBe('도시환경정비구역');
  });
});
