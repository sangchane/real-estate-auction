// 개발구역 레이어 응답 DTO — 지도가 변환 없이 그대로 그릴 수 있게 GeoJSON FeatureCollection 형태로 고정한다
// (설계 05 EP-1). 지도 라이브러리가 이 규격을 이미 알고 있어, 우리 형식으로 내려주면 클라이언트마다 변환기가 생긴다.

/**
 * `ST_AsGeoJSON`이 만든 geometry. 좌표 배열을 API가 다시 해석하지 않으므로 최소 형태만 고정한다 —
 * 여기서 폴리곤 구조를 타입으로 못 박으면 대상지(Point) 같은 다른 종류가 들어올 때 거짓말이 된다.
 */
export interface ZoneGeometryDto {
  type: string;
  coordinates: unknown;
}

export interface ZoneFeaturePropertiesDto {
  zoneId: number;
  /**
   * 화면에 이름으로 낼 값. null이면 원천에 이름이 없다는 사실이다.
   * 원천이 이름과 사업 종류를 두 필드에 섞어 써서, zoneName이 비면 businessKind에서
   * 조건부로 끌어온다 (zone-display-name.ts).
   */
  displayName: string | null;
  /** 이름을 businessKind에서 끌어왔는지 — 화면이 출처를 밝힐 수 있게 함께 내린다 */
  namePromoted: boolean;
  /** 원본 그대로. 승격 규칙이 틀렸을 때 근거를 볼 수 있어야 한다 */
  zoneName: string | null;
  businessKind: string | null;
  sigungu: string | null;
  /** 이 구역과 겹치는 물건 수(auction_item_zone). 0은 "겹치는 물건 없음"이라는 사실이다 */
  itemCount: number;
}

export interface ZoneFeatureDto {
  type: 'Feature';
  geometry: ZoneGeometryDto;
  properties: ZoneFeaturePropertiesDto;
}

export interface ZoneFeatureCollectionDto {
  type: 'FeatureCollection';
  /** 피처 상한에 걸려 잘렸는지. 잘린 것을 숨기면 화면이 "구역 없음"과 구분하지 못한다 (설계 05 EP-1) */
  truncated: boolean;
  features: ZoneFeatureDto[];
}
