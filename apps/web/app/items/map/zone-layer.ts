// 정비구역 레이어의 순수 로직 — /zones 응답 런타임 검증과 GeoJSON 지오메트리 → 폴리곤 링 좌표 변환.
// 지도 SDK 없이도 검증할 수 있게 MapView에서 떼어 둔다 (cluster.ts와 같은 구성).

/**
 * 이 줌보다 낮으면 정비구역을 그리지도, 조회하지도 않는다.
 *
 * 두 가지가 같은 지점에서 만난다.
 * - 읽힘: 1400px 지도의 가로 폭은 z14에서 약 0.12°(≈10.6km)라 1px이 약 7.6m다. 폭 200m짜리 구역이
 *   26px로 모양이 남는다. z13이면 15m/px라 13px, z12면 30m/px라 6px — 윤곽선 두께에 도형이 먹혀
 *   구역이 점으로 보인다. 점을 그릴 바에는 안 그리는 편이 낫다.
 * - 부하: 같은 계산으로 z13은 서울 전체, z12는 수도권이 한 화면에 들어온다. 그 범위의 구역은
 *   수백 개고 폴리곤마다 꼭짓점이 수십~수백 개다. z14는 자치구 몇 개 수준으로 줄어든다.
 *
 * 구역 실적재 후 실제 개수를 재보고 조정할 값이다(지금 테이블이 비어 있어 개수는 추정이다).
 */
export const ZONE_MIN_ZOOM = 14;

/** 링 하나로 인정할 최소 좌표 수. 두 점은 선분이지 경계가 아니다. */
const MIN_RING_POSITIONS = 3;

export interface ZoneProperties {
  zoneId: number;
  /** 화면에 낼 이름. 원천이 이름과 종류를 섞어 써서 API가 골라준다 */
  displayName: string | null;
  /** 이름을 businessKind에서 끌어왔는지 — 출처를 밝히는 데 쓴다 */
  namePromoted: boolean;
  zoneName: string | null;
  businessKind: string | null;
  sigungu: string | null;
  /** 이 구역과 겹치는 물건 수. 0은 "겹치는 물건 없음"이라는 사실이다 */
  itemCount: number;
}

export interface ZoneFeature {
  properties: ZoneProperties;
  /** 폴리곤 링 목록. 좌표는 GeoJSON 순서 그대로 [lng, lat]이다. */
  rings: [number, number][][];
}

export interface ZoneCollection {
  features: ZoneFeature[];
  /** 서버 상한에 걸려 잘렸는지. 숨기면 화면이 "구역 없음"과 구분하지 못한다 */
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toPosition(value: unknown): [number, number] | null {
  if (!Array.isArray(value)) return null;
  const [lng, lat] = value;
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function toRing(value: unknown): [number, number][] | null {
  if (!Array.isArray(value)) return null;
  const ring: [number, number][] = [];
  for (const entry of value) {
    const position = toPosition(entry);
    // 깨진 점 하나만 빼면 남은 점끼리 이어져 실제와 다른 경계가 그려진다 — 링째로 버린다.
    if (position === null) return null;
    ring.push(position);
  }
  return ring.length >= MIN_RING_POSITIONS ? ring : null;
}

function collectRings(coordinates: readonly unknown[]): [number, number][][] {
  const rings: [number, number][][] = [];
  for (const entry of coordinates) {
    const ring = toRing(entry);
    if (ring !== null) rings.push(ring);
  }
  return rings;
}

/**
 * GeoJSON 지오메트리에서 그릴 수 있는 링만 뽑는다.
 *
 * 대상지(후보)는 폴리곤 없이 rep_point만 있어서(마이그레이션 021) 지오메트리가 Point로 온다.
 * 점은 윤곽선이 될 수 없으므로 빈 배열이다 — 예외가 아니라 정상적인 결과다.
 */
export function zoneRings(geometry: unknown): [number, number][][] {
  if (!isRecord(geometry)) return [];
  const { type, coordinates } = geometry;
  if (!Array.isArray(coordinates)) return [];
  if (type === 'Polygon') return collectRings(coordinates);
  if (type === 'MultiPolygon') {
    // 윤곽선만 그리므로 어느 폴리곤에 속한 링인지 구분할 필요가 없어 한 줄로 펼친다.
    return coordinates.flatMap((polygon) => (Array.isArray(polygon) ? collectRings(polygon) : []));
  }
  return [];
}

function toProperties(value: unknown): ZoneProperties | null {
  if (!isRecord(value)) return null;
  const { zoneId, displayName, namePromoted, zoneName, businessKind, sigungu, itemCount } = value;
  // 식별자와 물건 수가 숫자가 아니면 화면이 만들 수 있는 문장이 없다.
  if (typeof zoneId !== 'number' || typeof itemCount !== 'number') return null;
  return {
    zoneId,
    displayName: typeof displayName === 'string' ? displayName : null,
    namePromoted: namePromoted === true,
    zoneName: typeof zoneName === 'string' ? zoneName : null,
    businessKind: typeof businessKind === 'string' ? businessKind : null,
    sigungu: typeof sigungu === 'string' ? sigungu : null,
    itemCount,
  };
}

function toFeature(value: unknown): ZoneFeature | null {
  if (!isRecord(value)) return null;
  const properties = toProperties(value.properties);
  if (properties === null) return null;
  const rings = zoneRings(value.geometry);
  // 그릴 링이 없는 구역은 폴리곤을 차지하지 않게 여기서 뺀다.
  if (rings.length === 0) return null;
  return { properties, rings };
}

/**
 * `/zones` 응답을 런타임 검증한다 (AGENTS.md 규칙 21).
 *
 * 껍데기가 어긋나면 예외로 끊고, 피처 하나가 어긋나면 그 피처만 버린다. 한 구역의 좌표가 깨졌다고
 * 레이어 전체를 비우면 나머지 구역까지 "없는 것"으로 보이기 때문이다.
 */
export function parseZoneCollection(data: unknown): ZoneCollection {
  if (!isRecord(data) || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('zones 응답이 FeatureCollection이 아님');
  }
  const features: ZoneFeature[] = [];
  for (const entry of data.features) {
    const feature = toFeature(entry);
    if (feature !== null) features.push(feature);
  }
  return { features, truncated: data.truncated === true };
}
