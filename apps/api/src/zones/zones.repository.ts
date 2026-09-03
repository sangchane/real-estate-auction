// 개발구역 조회 리포지토리 — redevelopment_zone 폴리곤을 지도 뷰포트로 잘라 GeoJSON으로 읽는다 (읽기 전용)
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, QueryResultRow } from 'pg';
import { PG_POOL } from '../auction-items/auction-items.repository';
import type { Bbox } from '../auction-items/dto/bbox.dto';
import type { DongBuildingAgeDto } from './dto/building-age.dto';
import type { ZoneFeatureCollectionDto, ZoneFeatureDto, ZoneGeometryDto } from './dto/zone-feature.dto';
import type {
  ItemZoningDistrictDto,
  ZoningFeatureCollectionDto,
  ZoningFeatureDto,
} from './dto/zoning.dto';
import { resolveZoneName } from './zone-display-name';

// 설계 04는 줌 구간별 사다리(z≤12 0.0005 / z13~14 0.0002 / z≥15 0.00005)를 뒀다. 여기서는 줌 대신
// bbox 폭에서 유도하므로 사다리의 양 끝값만 상·하한으로 남긴다.
const MIN_TOLERANCE_DEG = 0.00005;
const MAX_TOLERANCE_DEG = 0.0005;
// 뷰포트 긴 변의 1/700. 1024px 화면에서 1~2px 어긋남에 해당해 눈에 보이지 않고, 이 비율을 쓰면
// 설계 04 사다리의 양 끝(z12 폭 ≈0.35° → 0.0005 / z15 폭 ≈0.035° → 0.00005)과 그대로 맞아떨어진다.
const TOLERANCE_DIVISOR = 700;
// 용도지역은 정비구역보다 굵게(뷰포트 긴 변의 1/350 ≈ 2~4px) 깎는다. 채움 레이어라 1~2px 윤곽
// 정밀도가 시각적으로 안 사는 대신 피처가 10배(8,312)라 응답 크기가 문제다 — 실측(2026-09-01,
// 종로 z14 1,934피처)에서 1/700은 지오메트리만 886KB, 1/350이 684KB였다. 더 굵히면(1/175부터)
// 폭 200m급 폴리곤(z14에서 26px)의 모양 자체가 뭉개져 채움 경계가 실제와 다른 사실을 그린다.
const ZONING_TOLERANCE_DIVISOR = 350;

function toleranceFor(bbox: Bbox, divisor: number): number {
  const span = Math.max(bbox.maxLng - bbox.minLng, bbox.maxLat - bbox.minLat);
  return Math.min(MAX_TOLERANCE_DEG, Math.max(MIN_TOLERANCE_DEG, span / divisor));
}

/**
 * 조회 시 단순화 허용오차를 뷰포트 크기에서 유도한다.
 *
 * 원본 정밀도는 DB에 그대로 두고 단순화는 읽을 때만 한다(설계 04) — 단순화 결과를 저장하면 줌 정책이
 * 바뀔 때마다 전량 재적재가 필요해진다. 넓게 볼수록 한 픽셀이 담는 거리가 커지므로 허용오차도 같이
 * 키워야 응답 크기가 줌과 무관하게 비슷해진다.
 */
export function simplifyToleranceFor(bbox: Bbox): number {
  return toleranceFor(bbox, TOLERANCE_DIVISOR);
}

/** 용도지역 레이어의 허용오차 — 같은 사다리 양 끝값 안에서 divisor만 굵다 (상단 상수 주석) */
export function zoningSimplifyToleranceFor(bbox: Bbox): number {
  return toleranceFor(bbox, ZONING_TOLERANCE_DIVISOR);
}

// 클립 상자를 뷰포트보다 긴 변의 10%만큼 사방으로 넓힌다 — 절단이 만든 인공 직선 경계가 화면 밖에
// 놓여, 실제 용도지역 경계가 아닌 선이 화면에 그려지지 않는다.
const CLIP_PAD_RATIO = 0.1;

/**
 * 용도지역 지오메트리를 이 상자로 잘라낸다(ST_ClipByBox2D).
 *
 * 정비구역(776개, 소형)에는 없던 단계다 — 용도지역에는 자연녹지처럼 뷰포트 몇 배 크기의 폴리곤이
 * 있어 화면 밖 좌표가 응답의 상당분을 차지한다(실측 2026-09-01: 종로 z14 지오메트리 886KB →
 * 클립 후 767KB, 강남 702KB → 525KB). 원본 정밀도는 DB에 그대로 있다.
 */
export function clipBboxFor(bbox: Bbox): Bbox {
  const pad = Math.max(bbox.maxLng - bbox.minLng, bbox.maxLat - bbox.minLat) * CLIP_PAD_RATIO;
  return {
    minLng: bbox.minLng - pad,
    minLat: bbox.minLat - pad,
    maxLng: bbox.maxLng + pad,
    maxLat: bbox.maxLat + pad,
  };
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

// 물건 상세 쿼리와 공유하는 공통 컬럼 — 지오메트리는 bbox 쿼리에만 있다.
interface ItemZoningRow extends QueryResultRow {
  zoningId: string;
  zoningBucket: string | null;
  zoneNameRaw: string | null;
  sclasCl: string | null;
  mlsfcCl: string | null;
  baseYm: string;
}

interface ZoningRow extends ItemZoningRow {
  geometry: string;
}

// ORDER BY는 정비구역과 같은 이유다 — 상한에 잘릴 때 무엇이 남을지가 요청마다 흔들리면 화면이 깜빡인다.
const SELECT_ZONING = `
  SELECT
    z.id AS "zoningId",
    z.zoning_bucket AS "zoningBucket",
    z.zone_name_raw AS "zoneNameRaw",
    z.sclas_cl AS "sclasCl",
    z.mlsfc_cl AS "mlsfcCl",
    z.base_ym AS "baseYm",
    -- 클립($6~$9는 10% 패딩 상자) → 단순화 → 정밀도 6자리. 순서가 성능이다 — 잘라낸 뒤 깎아야
    -- 화면 밖 꼭짓점까지 단순화 비용을 치르지 않는다 (실측: 종로 z14 412ms → 338ms).
    ST_AsGeoJSON(ST_SimplifyPreserveTopology(
      ST_ClipByBox2D(z.geom, ST_MakeEnvelope($6, $7, $8, $9, 4326)), $5), 6) AS "geometry"
  FROM zoning_district z
  -- 도형 없는 행(원천 실측 1건)은 지도에 그릴 것이 없다 — 행 자체는 DB에 남아 있다.
  WHERE z.geom IS NOT NULL
    AND ST_Intersects(z.geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
  ORDER BY z.id
  LIMIT $10
`;

function toZoningFeature(row: ZoningRow): ZoningFeatureDto {
  return {
    type: 'Feature',
    // ST_AsGeoJSON이 만든 문자열이라 구조를 다시 검증하지 않고 파싱만 한다 — 외부 API 응답이 아니다.
    geometry: JSON.parse(row.geometry) as ZoneGeometryDto,
    properties: {
      // BIGSERIAL은 pg가 문자열로 준다 — 정비구역과 같은 변환.
      zoningId: Number(row.zoningId),
      // 버킷도 원문도 손대지 않고 그대로 내린다. NULL 버킷(미분류)을 여기서 가까운 버킷으로
      // 바꾸는 순간 적재기가 지킨 추측 배정 금지(기획 12 §2.4)가 무너진다.
      zoningBucket: row.zoningBucket,
      zoneNameRaw: row.zoneNameRaw,
      sclasCl: row.sclasCl,
      mlsfcCl: row.mlsfcCl,
    },
  };
}

// 물건 → 공간조인 사전계산(auction_item_zoning) → 용도지역. 다중 행이 정상이다 — 원천이 같은
// 자리의 옛 고시·재고시 폴리곤을 함께 담아(실측 10.6%, 022 주석) 한 장을 고르면 추측 배정이 된다.
const SELECT_ITEM_ZONING = `
  SELECT
    zd.id AS "zoningId",
    zd.zoning_bucket AS "zoningBucket",
    zd.zone_name_raw AS "zoneNameRaw",
    zd.sclas_cl AS "sclasCl",
    zd.mlsfc_cl AS "mlsfcCl",
    zd.base_ym AS "baseYm"
  FROM auction_item ai
  JOIN auction_case ac ON ac.id = ai.auction_case_id
  JOIN auction_item_zoning link ON link.auction_item_id = ai.id
  JOIN zoning_district zd ON zd.id = link.zoning_district_id
  WHERE ac.court_office_code = $1 AND ac.case_no = $2 AND ai.item_no = $3
  ORDER BY zd.id
`;

/**
 * 소수점 1자리 %(05 반올림 정책). 분모 0이면 null — 0%를 돌려주면 화면이
 * "노후 건물 없음"이라는 허위 사실을 만든다 (엣지 C-2, 021 컬럼 주석).
 */
export function ratioPct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

interface BuildingAgeRow extends QueryResultRow {
  bjdCode: string;
  dongName: string | null;
  baseYm: string;
  totalCount: number;
  unknownAprCount: number;
  over20Count: number;
  over30Count: number;
}

// 물건 → 법정동(auction_item_dong, 정확히 0..1) → 동별 집계. base_ym 내림차순 1건 —
// 집계가 여러 달 쌓여도 화면은 항상 가장 최근 기준연월 하나를 말한다.
const SELECT_BUILDING_AGE = `
  SELECT
    b.bjd_code AS "bjdCode",
    b.dong_name AS "dongName",
    b.base_ym AS "baseYm",
    b.total_count AS "totalCount",
    b.unknown_apr_count AS "unknownAprCount",
    b.over20_count AS "over20Count",
    b.over30_count AS "over30Count"
  FROM auction_item ai
  JOIN auction_case ac ON ac.id = ai.auction_case_id
  JOIN auction_item_dong d ON d.auction_item_id = ai.id
  JOIN building_age_dong b ON b.bjd_code = d.bjd_code
  WHERE ac.court_office_code = $1 AND ac.case_no = $2 AND ai.item_no = $3
  ORDER BY b.base_ym DESC
  LIMIT 1
`;

@Injectable()
export class ZonesRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** 물건이 속한 동의 노후도 집계. 동 매칭이 없거나 집계 전이면 null — 화면은 섹션을 그리지 않는다 */
  async findBuildingAgeForItem(
    courtOfficeCode: string,
    caseNo: string,
    itemNo: string,
  ): Promise<DongBuildingAgeDto | null> {
    const result = await this.pool.query<BuildingAgeRow>(SELECT_BUILDING_AGE, [
      courtOfficeCode,
      caseNo,
      itemNo,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      over20RatioPct: ratioPct(row.over20Count, row.totalCount),
      over30RatioPct: ratioPct(row.over30Count, row.totalCount),
    };
  }

  async findZoningInBbox(bbox: Bbox, limit: number): Promise<ZoningFeatureCollectionDto> {
    const clip = clipBboxFor(bbox);
    // limit+1을 읽어야 "딱 limit건"과 "잘렸다"를 구분할 수 있다 (정비구역과 같은 규약).
    const result = await this.pool.query<ZoningRow>(SELECT_ZONING, [
      bbox.minLng,
      bbox.minLat,
      bbox.maxLng,
      bbox.maxLat,
      zoningSimplifyToleranceFor(bbox),
      clip.minLng,
      clip.minLat,
      clip.maxLng,
      clip.maxLat,
      limit + 1,
    ]);

    const truncated = result.rows.length > limit;
    const rows = truncated ? result.rows.slice(0, limit) : result.rows;
    // 전량 교체 적재라 한 응답 안에서 base_ym은 같지만, 폴백 원천이 섞이는 날 오래된 연월을
    // 출처로 말하지 않게 최신값을 고른다.
    const baseYm = rows.reduce<string | null>(
      (acc, row) => (acc === null || row.baseYm > acc ? row.baseYm : acc),
      null,
    );
    return { type: 'FeatureCollection', truncated, baseYm, features: rows.map(toZoningFeature) };
  }

  /** 물건이 속한 용도지역 사실 목록. 빈 배열 = 좌표가 없거나 조인 전 — 화면은 섹션을 그리지 않는다 */
  async findZoningForItem(
    courtOfficeCode: string,
    caseNo: string,
    itemNo: string,
  ): Promise<ItemZoningDistrictDto[]> {
    const result = await this.pool.query<ItemZoningRow>(SELECT_ITEM_ZONING, [
      courtOfficeCode,
      caseNo,
      itemNo,
    ]);
    return result.rows.map((row) => ({
      zoningId: Number(row.zoningId),
      zoningBucket: row.zoningBucket,
      zoneNameRaw: row.zoneNameRaw,
      sclasCl: row.sclasCl,
      mlsfcCl: row.mlsfcCl,
      baseYm: row.baseYm,
    }));
  }

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
