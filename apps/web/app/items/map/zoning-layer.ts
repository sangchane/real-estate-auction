// 용도지역 레이어의 순수 로직 — /zones/zoning 응답 런타임 검증과 채색 버킷 → 램프 색 매핑.
// 지도 SDK 없이도 검증할 수 있게 MapView에서 떼어 둔다 (zone-layer.ts와 같은 구성).
import { colors } from '@auction/design-tokens';
import { ZONING_BUCKET_LABEL } from '../zoning';
import { zoneRings } from './zone-layer';

/**
 * 이 줌보다 낮으면 용도지역을 그리지도, 조회하지도 않는다.
 *
 * 정비구역의 ZONE_MIN_ZOOM과 같은 값이지만 이유의 무게가 다르다 — 용도지역은 서울 전역 8,312
 * 폴리곤으로 구역(776)의 한 자릿수 위다. z14 뷰포트 실측(2026-09-01, 밀집 5곳)이 912~1,934,
 * z13 이하는 2,323~5,594로 상한(2,000)에 걸려 **화면 한가운데가 조용히 빠진다**. 채움 레이어의
 * 구멍은 "이 자리는 용도지역 없음"이라는 허위 사실이라, 잘라 보여주느니 안내를 띄운다.
 */
export const ZONING_MIN_ZOOM = 14;

/**
 * 범례 — 순서가 곧 명도 사다리이고, 명도 사다리는 국토계획법 시행령의 법정 세분 순서다.
 * 순서를 순서로 인코딩하는 것이라 판단이 아니다 (기획 12 §2.4, DA-10과 같은 논리).
 *
 * "그 밖"·미분류가 여기 없는 것은 채색하지 않기 때문이다 — 중립 항목은 범례 컴포넌트가 따로 적는다.
 */
export const ZONING_LEGEND = [
  { bucket: 'RES_EXCLUSIVE', label: ZONING_BUCKET_LABEL.RES_EXCLUSIVE, fill: colors.mapSeq1 },
  { bucket: 'RES_GENERAL_1', label: ZONING_BUCKET_LABEL.RES_GENERAL_1, fill: colors.mapSeq2 },
  { bucket: 'RES_GENERAL_2', label: ZONING_BUCKET_LABEL.RES_GENERAL_2, fill: colors.mapSeq3 },
  { bucket: 'RES_GENERAL_3', label: ZONING_BUCKET_LABEL.RES_GENERAL_3, fill: colors.mapSeq4 },
  { bucket: 'RES_SEMI', label: ZONING_BUCKET_LABEL.RES_SEMI, fill: colors.mapSeq5 },
] as const;

const FILL_BY_BUCKET = new Map<string, string>(
  ZONING_LEGEND.map((entry) => [entry.bucket, entry.fill]),
);

/**
 * 버킷의 채움 색. null = 채색하지 않음(윤곽선만).
 *
 * "그 밖"(OTHER)과 미분류(null)와 **사전에 없는 새 버킷**이 모두 여기로 온다. 셋 다 색을 주지
 * 않는 이유가 같다 — 모르는 값을 가까운 색으로 칠하는 순간 지도가 허위 사실을 그린다
 * (기획 12 §2.4, 적재기의 추측 배정 금지와 같은 원칙). 적재기가 버킷을 늘리는 날에도 화면은
 * 조용히 틀리지 않고 중립으로 남는다.
 */
export function zoningFillColor(bucket: string | null): string | null {
  if (bucket === null) return null;
  return FILL_BY_BUCKET.get(bucket) ?? null;
}

export interface ZoningProperties {
  zoningId: number;
  /** 채색 키. null = 미분류 — 화면은 중립으로 그리고 원문 명칭으로 말한다 */
  zoningBucket: string | null;
  /** DGM_NM 원문. 카드가 이 값을 그대로 보여준다 — "(7층이하)" 같은 고시 세부 포함 */
  zoneNameRaw: string | null;
  sclasCl: string | null;
  mlsfcCl: string | null;
}

export interface ZoningFeature {
  properties: ZoningProperties;
  /** 폴리곤 링 목록. 좌표는 GeoJSON 순서 그대로 [lng, lat]이다. */
  rings: [number, number][][];
}

export interface ZoningCollection {
  features: ZoningFeature[];
  /** 서버 상한에 걸려 잘렸는지. 숨기면 화면이 "용도지역 없음"과 구분하지 못한다 */
  truncated: boolean;
  /** 원천 파일 기준연월(YYYY-MM). 범례의 출처 표기가 쓴다. 피처가 없으면 null */
  baseYm: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toProperties(value: unknown): ZoningProperties | null {
  if (!isRecord(value)) return null;
  const { zoningId, zoningBucket, zoneNameRaw, sclasCl, mlsfcCl } = value;
  // 식별자가 숫자가 아니면 폴리곤을 칸에 담아 다시 찾을 수 없다.
  if (typeof zoningId !== 'number') return null;
  return {
    zoningId,
    zoningBucket: toText(zoningBucket),
    zoneNameRaw: toText(zoneNameRaw),
    sclasCl: toText(sclasCl),
    mlsfcCl: toText(mlsfcCl),
  };
}

function toFeature(value: unknown): ZoningFeature | null {
  if (!isRecord(value)) return null;
  const properties = toProperties(value.properties);
  if (properties === null) return null;
  // 링 추출은 정비구역과 완전히 같다(같은 GeoJSON 규약) — 복제하지 않고 그 함수를 쓴다.
  const rings = zoneRings(value.geometry);
  if (rings.length === 0) return null;
  return { properties, rings };
}

/**
 * 이 점이 링 안쪽인지 — 짝홀(even-odd) 규칙의 광선 교차 판정.
 *
 * 정비구역 카드가 "그 자리의 용도지역"을 한 줄 병기하는 데 쓴다 (기획 12 §3.5). 서버에 다시 묻지
 * 않는 이유는 이미 그리고 있는 폴리곤이 답을 들고 있어서다. 한 피처의 모든 링(바깥 경계와 구멍)을
 * 한 번에 세는데, 짝홀 규칙에서는 구멍 안의 점이 두 번 교차해 자연히 바깥으로 나온다.
 *
 * 좌표는 화면용으로 단순화·클립된 값이라 경계선에서 몇 미터의 오차가 있다. 병기 한 줄에는 충분하고,
 * 물건이 속한 용도지역이라는 **사실**은 이 값이 아니라 서버의 공간조인(auction_item_zoning)이 말한다.
 */
export function pointInRings(rings: readonly (readonly [number, number][])[], lng: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const a = ring[i];
      const b = ring[j];
      if (a === undefined || b === undefined) continue;
      const [aLng, aLat] = a;
      const [bLng, bLat] = b;
      // 변이 이 위도를 가로지를 때만, 그 위도에서의 변의 경도와 비교한다.
      if (aLat > lat !== bLat > lat && lng < ((bLng - aLng) * (lat - aLat)) / (bLat - aLat) + aLng) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** 이 좌표를 덮는 첫 용도지역. 겹쳐 있으면 먼저 그려진 것을 쓴다 — 병기 한 줄에 여럿을 넣지 않는다 */
export function zoningAt(
  features: readonly ZoningFeature[],
  lng: number,
  lat: number,
): ZoningFeature | null {
  return features.find((feature) => pointInRings(feature.rings, lng, lat)) ?? null;
}

/**
 * `/zones/zoning` 응답을 런타임 검증한다 (AGENTS.md 규칙 21).
 *
 * 껍데기가 어긋나면 예외로 끊고, 피처 하나가 어긋나면 그 피처만 버린다 — 한 폴리곤의 좌표가
 * 깨졌다고 레이어를 비우면 나머지 용도지역까지 "없는 것"으로 보인다 (parseZoneCollection과 같은 규칙).
 */
export function parseZoningCollection(data: unknown): ZoningCollection {
  if (!isRecord(data) || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('zoning 응답이 FeatureCollection이 아님');
  }
  const features: ZoningFeature[] = [];
  for (const entry of data.features) {
    const feature = toFeature(entry);
    if (feature !== null) features.push(feature);
  }
  return { features, truncated: data.truncated === true, baseYm: toText(data.baseYm) };
}
