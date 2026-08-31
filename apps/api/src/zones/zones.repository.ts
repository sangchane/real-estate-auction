// 개발구역 조회 리포지토리 — redevelopment_zone 폴리곤을 지도 뷰포트로 잘라 GeoJSON으로 읽는다 (읽기 전용)
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, QueryResultRow } from 'pg';
import { PG_POOL } from '../auction-items/auction-items.repository';
import type { Bbox } from '../auction-items/dto/bbox.dto';
import type { ZoneFeatureCollectionDto, ZoneFeatureDto, ZoneGeometryDto } from './dto/zone-feature.dto';
import { resolveZoneName } from './zone-display-name';

// 설계 04는 줌 구간별 사다리(z≤12 0.0005 / z13~14 0.0002 / z≥15 0.00005)를 뒀다. 여기서는 줌 대신
// bbox 폭에서 유도하므로 사다리의 양 끝값만 상·하한으로 남긴다.
const MIN_TOLERANCE_DEG = 0.00005;
const MAX_TOLERANCE_DEG = 0.0005;
// 뷰포트 긴 변의 1/700. 1024px 화면에서 1~2px 어긋남에 해당해 눈에 보이지 않고, 이 비율을 쓰면
// 설계 04 사다리의 양 끝(z12 폭 ≈0.35° → 0.0005 / z15 폭 ≈0.035° → 0.00005)과 그대로 맞아떨어진다.
const TOLERANCE_DIVISOR = 700;

/**
 * 조회 시 단순화 허용오차를 뷰포트 크기에서 유도한다.
 *
 * 원본 정밀도는 DB에 그대로 두고 단순화는 읽을 때만 한다(설계 04) — 단순화 결과를 저장하면 줌 정책이
 * 바뀔 때마다 전량 재적재가 필요해진다. 넓게 볼수록 한 픽셀이 담는 거리가 커지므로 허용오차도 같이
 * 키워야 응답 크기가 줌과 무관하게 비슷해진다.
 */
export function simplifyToleranceFor(bbox: Bbox): number {
  const span = Math.max(bbox.maxLng - bbox.minLng, bbox.maxLat - bbox.minLat);
  return Math.min(MAX_TOLERANCE_DEG, Math.max(MIN_TOLERANCE_DEG, span / TOLERANCE_DIVISOR));
}

interface ZoneRow extends QueryResultRow {
  zoneId: string;
  zoneName: string | null;
  businessKind: string | null;
  sigungu: string | null;
  geometry: string;
  itemCount: string;
}

// 대상지(후보)는 폴리곤이 없고 rep_point만 있다(마이그레이션 021 주석). geom만 보면 그런 구역이
// 지도에서 통째로 사라지므로 좌표 원천을 한 식으로 묶어 필터·출력에 같이 쓴다.
const ZONE_GEOM = 'COALESCE(z.geom, z.rep_point)';

// ORDER BY는 상한에 걸려 잘릴 때 무엇이 남을지 정하는 규칙이다. 정렬을 빼면 같은 뷰포트를 두 번
// 봐도 다른 구역이 사라져 화면이 깜빡인다.
const SELECT_ZONES = `
  SELECT
    z.id AS "zoneId",
    z.zone_name AS "zoneName",
    z.business_kind AS "businessKind",
    z.sigungu AS "sigungu",
    -- 좌표 정밀도 6자리(약 0.1m) 고정. 기본값 9자리는 화면에서 구분되지 않는 자릿수로 응답만 키운다 (설계 08 m-14).
    ST_AsGeoJSON(ST_SimplifyPreserveTopology(${ZONE_GEOM}, $5), 6) AS "geometry",
    (SELECT count(*) FROM auction_item_zone aiz WHERE aiz.zone_id = z.id) AS "itemCount"
  FROM redevelopment_zone z
  -- 원천에서 사라진 구역은 지우지 않고 마킹만 하므로(021), 조회에서 빼는 것은 여기 한 곳의 책임이다.
  WHERE z.retired_at IS NULL
    AND ${ZONE_GEOM} IS NOT NULL
    AND ST_Intersects(${ZONE_GEOM}, ST_MakeEnvelope($1, $2, $3, $4, 4326))
  ORDER BY z.id
  LIMIT $6
`;

function toFeature(row: ZoneRow): ZoneFeatureDto {
  return {
    type: 'Feature',
    // ST_AsGeoJSON이 만든 문자열이라 구조를 다시 검증하지 않고 파싱만 한다 — 외부 API 응답이 아니다.
    geometry: JSON.parse(row.geometry) as ZoneGeometryDto,
    properties: {
      // BIGINT·count는 pg가 문자열로 준다. 그대로 내리면 화면에서 숫자 비교가 문자열 비교가 된다.
      zoneId: Number(row.zoneId),
      // 원천이 이름과 사업 종류를 두 필드에 섞어 써서 표시할 이름을 여기서 고른다.
      // 원본 컬럼(zoneName·businessKind)은 그대로 함께 내린다 — 승격이 틀렸을 때 화면이
      // 근거를 보여줄 수 있어야 하고, 나중에 진짜 이름을 받으면 이 한 줄만 걷어내면 된다.
      ...(() => {
        const naming = resolveZoneName(row.zoneName, row.businessKind);
        return { displayName: naming.displayName, namePromoted: naming.promoted };
      })(),
      zoneName: row.zoneName,
      businessKind: row.businessKind,
      sigungu: row.sigungu,
      itemCount: Number(row.itemCount),
    },
  };
}

@Injectable()
export class ZonesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findZonesInBbox(bbox: Bbox, limit: number): Promise<ZoneFeatureCollectionDto> {
    // limit+1을 읽어야 "딱 limit건"과 "잘렸다"를 구분할 수 있다.
    const result = await this.pool.query<ZoneRow>(SELECT_ZONES, [
      bbox.minLng,
      bbox.minLat,
      bbox.maxLng,
      bbox.maxLat,
      simplifyToleranceFor(bbox),
      limit + 1,
    ]);

    const truncated = result.rows.length > limit;
    const rows = truncated ? result.rows.slice(0, limit) : result.rows;
    return { type: 'FeatureCollection', truncated, features: rows.map(toFeature) };
  }
}
