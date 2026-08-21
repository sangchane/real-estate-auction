// 물건 조회 리포지토리 — WP-02 수집기가 채운 auction_item/auction_case/auction_item_raw를 읽기 전용으로 조회.
// usageName/deptName/시도/시군구는 별도 컬럼이 없어 WP-02가 저장해 둔 원문 스냅샷(auction_item_raw.payload)에서 읽는다.
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, QueryResultRow } from 'pg';
import type { AuctionCasePhotoDto } from './dto/auction-case-photo.dto';
import type { AffordabilityDto, ComparableSaleStatsDto } from './dto/affordability.dto';
import type { AssumedDepositDto, AuctionItemDto } from './dto/auction-item.dto';
import type { Bbox } from './dto/bbox.dto';
import type { NoticeAnalysisDto } from './dto/notice-analysis.dto';
import type { RegionCountDto } from './dto/region-count.dto';
import { classifyNoticeAssumption } from '../rights-analysis/domain/notice-assumption';
import { OBSERVED_FROM } from '../backtest/backtest.repository';
import { assumedTotalOf, computeAffordability } from './affordability';
import { mergeNoticeTenants } from './notice-tenant-merge';
import { mergeSuccessions } from './notice-tenant-succession';

// 법원 convAddr 접두사 → 면적 종류 코드. 화면이 평당가 분모를 고르는 근거라 문자열을 그대로
// 흘리지 않고 코드로 고정한다.
const AREA_KIND: Record<string, 'AGGREGATE' | 'LAND' | 'BUILDING'> = {
  집합건물: 'AGGREGATE',
  토지: 'LAND',
  건물: 'BUILDING',
};

export const PG_POOL = Symbol('PG_POOL');

interface NoticeRow {
  id: string;
  documentDate: Date | string | null;
  baselineRaw: string | null;
  baselineDate: Date | string | null;
  distributionDemandDeadline: Date | string | null;
  assumedRightsKind: string | null;
  riskFlags: string[] | null;
}

interface NoticeTenantRow {
  /** 보증기관이 신고한 행인지 — 성명 대신 이 불리언만 SELECT한다 */
  isGuarantor: boolean | null;
  tenantSeq: number;
  sourceKind: string | null;
  occupiedPart: string | null;
  moveInDate: Date | string | null;
  fixedDate: Date | string | null;
  depositAmount: string | number | null;
  demandedDistribution: boolean | null;
  demandedDistributionDate: Date | string | null;
}

/**
 * pg가 date 컬럼으로 준 값을 YYYY-MM-DD로 만든다.
 *
 * `toISOString()`을 쓰면 안 된다 — pg는 date를 **로컬 자정** Date로 만들어서, KST(UTC+9)에서
 * UTC로 옮기면 전날이 된다(2020-07-29 → 2020-07-28). 대항력은 하루 차이로 뒤집히는 판정이라
 * 여기서 밀리면 인수 여부가 통째로 달라진다. 로컬 필드를 그대로 읽는다.
 */
export function toIsoDate(value: Date | string | null): string | null {
  if (value === null) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${value.getFullYear()}-${month}-${day}`;
}

const JOIN_RAW_AND_SCHEDULE = `
  FROM auction_item ai
  JOIN auction_case ac ON ac.id = ai.auction_case_id
  LEFT JOIN LATERAL (
    SELECT payload FROM auction_item_raw
    WHERE auction_item_id = ai.id
    ORDER BY observed_at DESC LIMIT 1
  ) raw ON true
  LEFT JOIN LATERAL (
    SELECT bid_datetime FROM auction_schedule
    WHERE auction_item_id = ai.id
    ORDER BY observed_at DESC LIMIT 1
  ) sch ON true
  -- 매각물건명세서는 기일마다 새로 작성되므로 가장 최근 것 하나만 쓴다 (수집기 §4-13).
  -- 점유자 수는 tenant_seq로 센다 — 같은 사람이 정보출처별로 여러 행에 나오기 때문이다 (§4-8).
  LEFT JOIN LATERAL (
    SELECT
      n.id AS notice_id,
      n.baseline_date,
      n.distribution_demand_deadline,
      n.assumed_rights_kind,
      n.risk_flags,
      (SELECT count(DISTINCT t.tenant_seq)
         FROM auction_item_notice_tenant t WHERE t.notice_id = n.id) AS tenant_count
    FROM auction_item_notice n
    WHERE n.auction_item_id = ai.id
    ORDER BY n.document_date DESC NULLS LAST, n.id DESC LIMIT 1
  ) ntc ON true
`;

/**
 * 목록 조회 필터. 지역·유형·가격 세 축은 경매를 좁히는 기본 손잡이라 함께 다룬다.
 *
 * `usages`는 **용도 원문의 첫 조각**이다(예: `아파트`, `다세대`). 법원이 용도를 콤마로 묶어
 * 보내므로 첫 조각으로 판정하는 것이 화면(shortUsageName·usage-category)과 같은 기준이다.
 * 범주(APARTMENT 등)로 묶는 규칙은 화면이 갖고 있고 API는 이름 목록만 받는다 — 매핑이
 * 두 곳에 생기면 갈라진다.
 */
export interface ItemListFilter {
  sido?: string;
  sigungu?: string;
  usages?: string[];
  minPrice?: number;
  maxPrice?: number;
  sort?: ItemListSort;
}

export type ItemListSort = 'recent' | 'bidDate' | 'priceAsc' | 'priceDesc' | 'failedDesc';

// 목록과 건수가 같은 조건을 봐야 "전체 N건"이 목록과 어긋나지 않는다 — 조건을 한 곳에 둔다.
// $1·$2는 목록에서 limit·offset이라 필터는 $3부터 시작한다.
const LIST_CONDITIONS = (base: number) => `
  WHERE ($${base}::text IS NULL OR raw.payload->>'hjguSido' = $${base})
    AND ($${base + 1}::text IS NULL OR raw.payload->>'hjguSigu' = $${base + 1})
    AND ($${base + 2}::text[] IS NULL
         OR split_part(raw.payload->>'dspslUsgNm', ',', 1) = ANY($${base + 2}))
    AND ($${base + 3}::bigint IS NULL OR ai.minimum_sale_price >= $${base + 3})
    AND ($${base + 4}::bigint IS NULL OR ai.minimum_sale_price <= $${base + 4})`;

const LIST_WHERE = LIST_CONDITIONS(3);
const LIST_WHERE_COUNT = LIST_CONDITIONS(1);

function listFilterValues(filter: ItemListFilter): (string | string[] | number | null)[] {
  return [
    filter.sido ?? null,
    filter.sigungu ?? null,
    filter.usages && filter.usages.length > 0 ? filter.usages : null,
    filter.minPrice ?? null,
    filter.maxPrice ?? null,
  ];
}

/**
 * 정렬 기준. 사용자가 고르는 값이라 화이트리스트로만 SQL에 넣는다(문자열 결합 금지).
 *
 * 기일 임박순은 지난 기일을 뒤로 보낸다 — 이미 지난 물건이 맨 위에 오면 목록이 쓸모없어진다.
 */
function orderBy(sort: ItemListSort | undefined): string {
  switch (sort) {
    case 'bidDate':
      return `(sch.bid_datetime < now()), sch.bid_datetime ASC NULLS LAST`;
    case 'priceAsc':
      return `ai.minimum_sale_price ASC NULLS LAST`;
    case 'priceDesc':
      return `ai.minimum_sale_price DESC NULLS LAST`;
    case 'failedDesc':
      return `ai.failed_bid_count DESC NULLS LAST`;
    default:
      return `ai.updated_at DESC`;
  }
}

const SELECT_AND_FROM = `
  SELECT
    ac.court_office_code AS "courtOfficeCode",
    ac.case_no AS "caseNo",
    ai.item_no AS "itemNo",
    ac.court_name AS "courtName",
    raw.payload->>'jpDeptNm' AS "deptName",
    raw.payload->>'dspslUsgNm' AS "usageName",
    -- 면적(㎡)과 그 종류. 종류마다 평당가의 분모가 다르므로 값만 주면 화면이 잘못 쓴다.
    --   집합건물(370) → 전유면적 / 토지(63) → 대지면적 / 건물(31) → 연면적(층별 합계)
    -- 업계도 같은 구분을 쓴다: 두인경매는 검색 파라미터가 landSqm·bldgSqm 두 스칼라이고,
    -- 마이옥션 요약란은 "토지면적 258.00㎡ / 건물면적 382.44㎡"로 나눠 적는다.
    -- 건물면적이 층별 합계라는 것은 실측 검산으로 확인했다(17.4 + 121.68×3 = 382.44).
    -- 템플릿 리터럴이라 백슬래시를 \\로 써야 Postgres까지 그대로 간다 (\[ 는 [ 가 되어 정규식이 깨진다)
    (regexp_match(raw.payload->>'convAddr', '^\\[(집합건물|건물|토지)'))[1] AS "areaKind",
    -- 표기된 ㎡를 모두 더한다. 다층 건물은 연면적, 여러 필지는 토지 합계가 되어 업계 표기와 맞는다.
    -- 법원이 자유 텍스트로 주므로("철근콘크리트구조 47.52㎡", "1층 44.30㎡ 2층 44.30㎡") 정규식으로 뽑는다.
    (SELECT NULLIF(sum(replace(m[1], ',', '')::numeric), 0)
       FROM regexp_matches(
         COALESCE(NULLIF(raw.payload->>'areaList', ''), raw.payload->>'pjbBuldList', ''),
         '([0-9][0-9,]*\\.?[0-9]*)\\s*㎡', 'g') m) AS "areaM2",
    -- 일괄매각 여부. 이 물건들은 **면적과 가격의 단위가 어긋난다** — convAddr에는 목적물 하나의
    -- 면적만 있는데 최저가는 묶음 전체다(실측: 34.32㎡ 상가에 최저가 340억이 붙어 평당 32.8억).
    -- WP-11 §4-2에 기록된 "일괄매각은 물건마다 같은 감정가·최저가를 갖는다"와 같은 함정이라
    -- 화면이 단가를 계산하지 않도록 신호를 내려보낸다. 면적 자체는 그 목적물 값이라 보여줘도 된다.
    (COALESCE(raw.payload->>'mulBigo', '') LIKE '%일괄%') AS "bulkSale",
    ai.address AS "address",
    ai.appraisal_amount AS "appraisalAmount",
    ai.minimum_sale_price AS "minimumSalePrice",
    ai.failed_bid_count AS "failedBidCount",
    sch.bid_datetime AS "bidDatetime",
    ntc.assumed_rights_kind AS "assumedRightsKind",
    ntc.risk_flags AS "riskFlags",
    ntc.tenant_count AS "tenantCount",
    -- 인수 보증금 요약은 SQL로 계산하지 않는다 — 대항력 판정 규칙이 두 곳으로 갈라진다.
    -- 명세서 키와 판정 기준일만 싣고, 판정은 withAssumedDeposit이 도메인 함수로 돌린다.
    ntc.notice_id AS "noticeId",
    ntc.baseline_date AS "noticeBaselineDate",
    ntc.distribution_demand_deadline AS "noticeDistributionDemandDeadline",
    ST_X(ai.geom) AS "lng",
    ST_Y(ai.geom) AS "lat"
  ${JOIN_RAW_AND_SCHEDULE}
`;

interface AuctionItemRow extends QueryResultRow {
  courtOfficeCode: string;
  caseNo: string;
  itemNo: string;
  courtName: string | null;
  deptName: string | null;
  usageName: string | null;
  areaKind: string | null;
  areaM2: string | null;
  bulkSale: boolean;
  address: string | null;
  appraisalAmount: string | null;
  minimumSalePrice: string | null;
  failedBidCount: number | null;
  bidDatetime: Date | null;
  assumedRightsKind: string | null;
  riskFlags: string[] | null;
  tenantCount: string | null;
  // 아래 셋은 인수 보증금 계산용 내부 값이다 — DTO로 내보내지 않는다(toDto에서 걷어낸다)
  noticeId: string | null;
  noticeBaselineDate: Date | string | null;
  noticeDistributionDemandDeadline: Date | string | null;
  lng: number | null;
  lat: number | null;
}

function toDto(row: AuctionItemRow, assumedDeposit: AssumedDepositDto | null): AuctionItemDto {
  // 내부 계산용 컬럼은 스프레드에서 빼낸다 — `...row`로 흘리면 응답 스키마가 조용히 늘어난다
  const { noticeId, noticeBaselineDate, noticeDistributionDemandDeadline, ...rest } = row;
  void noticeId;
  void noticeBaselineDate;
  void noticeDistributionDemandDeadline;

  return {
    ...rest,
    appraisalAmount: row.appraisalAmount === null ? null : Number(row.appraisalAmount),
    minimumSalePrice: row.minimumSalePrice === null ? null : Number(row.minimumSalePrice),
    // numeric은 pg가 문자열로 준다. undefined도 NaN이 되지 않게 ==로 받는다
    areaKind: AREA_KIND[row.areaKind ?? ''] ?? null,
    areaM2: row.areaM2 == null ? null : Number(row.areaM2),
    bidDatetime: row.bidDatetime === null ? null : row.bidDatetime.toISOString(),
    // 명세서가 없는 물건은 "위험 없음"이 아니라 "확인 못 함"이다 — 빈 배열과 null을 구분한다
    riskFlags: row.riskFlags ?? [],
    // ?? 로 받는다 — null만 검사하면 컬럼이 undefined일 때 Number(undefined)가 NaN이 된다
    tenantCount: row.tenantCount == null ? null : Number(row.tenantCount),
    assumedDeposit,
  };
}

/** 인수 보증금 계산에 필요한 명세서 키·기준일. 목록 SELECT와 관심목록 SELECT가 함께 만족한다. */
export interface NoticeMetaRow {
  noticeId: string | null;
  noticeBaselineDate: Date | string | null;
  noticeDistributionDemandDeadline: Date | string | null;
}

/**
 * 명세서별 인수 보증금 요약을 한 번에 계산한다 — 목록·지도·관심목록 카드가 대항력 있는 임차인의
 * 존재를 한눈에 보이게 하는 값이다.
 *
 * 판정은 상세 화면과 **똑같은 도메인 함수**로 돌린다(mergeNoticeTenants →
 * classifyNoticeAssumption → assumedTotalOf). SQL로 다시 쓰면 규칙이 두 곳으로 갈라져 목록과
 * 상세가 다른 숫자를 말하게 된다. 그래서 SELECT는 명세서 키와 기준일만 싣는다.
 *
 * 점유자 행은 물건 수와 무관하게 **한 번**만 조회한다(notice_id = ANY) — 물건당 쿼리를 돌리면
 * 목록 100건에서 N+1이 된다. 명세서가 없는 물건은 맵에 없고, 호출부가 null(=확인 못 함)로 둔다.
 */
export async function loadAssumedDeposits(
  pool: Pool,
  rows: readonly NoticeMetaRow[],
): Promise<Map<string, AssumedDepositDto>> {
  const metaById = new Map<string, NoticeMetaRow>();
  for (const row of rows) {
    // != null 로 받는다 — 컬럼이 빠진 SELECT에서 undefined가 오면 "명세서 있음"으로 잘못 읽힌다
    if (row.noticeId != null) metaById.set(row.noticeId, row);
  }
  const result = new Map<string, AssumedDepositDto>();
  if (metaById.size === 0) return result;

  const tenantResult = await pool.query<NoticeTenantRow & { noticeId: string }>(
    `SELECT notice_id AS "noticeId",
            tenant_seq AS "tenantSeq",
            -- 보증기관이 신고한 행인지만 계산해 넘긴다. **성명 자체는 SELECT하지 않는다** —
            -- 응답에 섞여 나갈 경로를 만들지 않는다는 이 파일의 결정을 지키면서, 대위 판정에
            -- 필요한 사실만 얻는다. 한국토지주택공사는 넣지 않는다(전세임대는 LH가 본인 임차인이다).
            (tenant_name ~ '(주택도시보증공사|한국주택금융공사|서울보증)') AS "isGuarantor",
            source_kind AS "sourceKind",
            occupied_part AS "occupiedPart",
            move_in_date AS "moveInDate",
            fixed_date AS "fixedDate",
            deposit_amount AS "depositAmount",
            demanded_distribution AS "demandedDistribution",
            demanded_distribution_date AS "demandedDistributionDate"
     FROM auction_item_notice_tenant
     WHERE notice_id = ANY($1::bigint[])
     ORDER BY notice_id, row_no`,
    [[...metaById.keys()]],
  );

  const byNotice = new Map<string, NoticeTenantRow[]>();
  for (const row of tenantResult.rows) {
    const bucket = byNotice.get(row.noticeId);
    if (bucket) bucket.push(row);
    else byNotice.set(row.noticeId, [row]);
  }

  for (const [noticeId, meta] of metaById) {
    // ?? null 로 받는다 — 기준일 컬럼이 빠지면 toIsoDate가 undefined에서 터진다
    const baselineDate = toIsoDate(meta.noticeBaselineDate ?? null);
    const deadline = toIsoDate(meta.noticeDistributionDemandDeadline ?? null);
    // 정보출처별로 흩어진 행을 사람 단위로 합친 뒤 판정한다 (findNoticeAnalysis와 같은 순서)
    const tenants = mergeSuccessions(
      mergeNoticeTenants(
      (byNotice.get(noticeId) ?? []).map((tenant) => ({
        tenantSeq: tenant.tenantSeq,
        isGuarantor: tenant.isGuarantor ?? false,
        sourceKind: tenant.sourceKind,
        occupiedPart: tenant.occupiedPart,
        moveInDate: toIsoDate(tenant.moveInDate),
        fixedDate: toIsoDate(tenant.fixedDate),
        depositAmount: tenant.depositAmount === null ? null : Number(tenant.depositAmount),
        demandedDistribution: tenant.demandedDistribution,
        demandedDistributionDate: toIsoDate(tenant.demandedDistributionDate),
      })),
      ),
    ).map((tenant) => {
      const verdict = classifyNoticeAssumption(tenant, baselineDate, deadline);
      return {
        ...tenant,
        possessionRightDate: verdict.possessionRightDate,
        hasPriority: verdict.hasPriority,
        distributionDemandEffective: verdict.distributionDemandEffective,
        assumption: verdict.assumption,
        assumedAmount: verdict.assumedAmount,
      };
    });
    result.set(noticeId, assumedTotalOf(tenants));
  }
  return result;
}

interface RegionCountRow extends QueryResultRow {
  region: string;
  count: string;
}

interface CaseIdRow extends QueryResultRow {
  caseId: string;
}

// id는 BIGSERIAL이라 pg가 문자열로 돌려준다 — DTO 변환 시 숫자로 바꾼다
interface PhotoMetaRow extends QueryResultRow {
  id: string;
  source: string;
  seq: number;
  categoryName: string | null;
  caption: string | null;
  contentType: string | null;
  byteSize: number;
}

interface PhotoBytesRow extends QueryResultRow {
  contentType: string | null;
  bytes: Buffer;
}

interface NoticePdfRow extends QueryResultRow {
  bytes: Buffer;
  documentDate: Date | null;
}

interface AffordabilityItemRow extends QueryResultRow {
  appraisalAmount: string | number | null;
  minimumSalePrice: string | number | null;
  usageName: string | null;
  bulkSale: boolean;
}

interface ComparableStatsRow extends QueryResultRow {
  sampleCount: string | number;
  rateP25: string | number | null;
  rateMedian: string | number | null;
  rateP75: string | number | null;
}

@Injectable()
export class AuctionItemsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  private async withAssumedDeposit(rows: AuctionItemRow[]): Promise<AuctionItemDto[]> {
    const deposits = await loadAssumedDeposits(this.pool, rows);
    return rows.map((row) => toDto(row, row.noticeId === null ? null : deposits.get(row.noticeId) ?? null));
  }

  async findOne(courtOfficeCode: string, caseNo: string, itemNo: string): Promise<AuctionItemDto | null> {
    const result = await this.pool.query<AuctionItemRow>(
      `${SELECT_AND_FROM} WHERE ac.court_office_code = $1 AND ac.case_no = $2 AND ai.item_no = $3`,
      [courtOfficeCode, caseNo, itemNo],
    );
    const row = result.rows[0];
    if (!row) return null;
    const [dto] = await this.withAssumedDeposit([row]);
    return dto ?? null;
  }

  async findMany(
    limit: number,
    offset: number,
    filter: ItemListFilter = {},
  ): Promise<AuctionItemDto[]> {
    const result = await this.pool.query<AuctionItemRow>(
      `${SELECT_AND_FROM}
       ${LIST_WHERE}
       ORDER BY ${orderBy(filter.sort)} LIMIT $1 OFFSET $2`,
      [limit, offset, ...listFilterValues(filter)],
    );
    return this.withAssumedDeposit(result.rows);
  }

  /**
   * 같은 조건의 전체 건수 — 목록 화면이 "전체 N건"과 페이지 끝을 알 수 있게 한다.
   *
   * 건수를 안 주면 사용자는 스크롤 끝까지 가봐야 얼마나 남았는지 안다. 조건을 좁힌 효과도
   * 숫자로 보이지 않는다.
   */
  async countMany(filter: ItemListFilter = {}): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       ${JOIN_RAW_AND_SCHEDULE}
       ${LIST_WHERE_COUNT}`,
      listFilterValues(filter),
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countBySido(): Promise<RegionCountDto[]> {
    const result = await this.pool.query<RegionCountRow>(
      `SELECT raw.payload->>'hjguSido' AS region, COUNT(*) AS count
       ${JOIN_RAW_AND_SCHEDULE}
       WHERE raw.payload->>'hjguSido' IS NOT NULL
       GROUP BY raw.payload->>'hjguSido'
       ORDER BY count DESC`,
    );
    return result.rows.map((row) => ({ name: row.region, count: Number(row.count) }));
  }

  async countBySigungu(sido: string): Promise<RegionCountDto[]> {
    const result = await this.pool.query<RegionCountRow>(
      `SELECT raw.payload->>'hjguSigu' AS region, COUNT(*) AS count
       ${JOIN_RAW_AND_SCHEDULE}
       WHERE raw.payload->>'hjguSido' = $1 AND raw.payload->>'hjguSigu' IS NOT NULL
       GROUP BY raw.payload->>'hjguSigu'
       ORDER BY count DESC`,
      [sido],
    );
    return result.rows.map((row) => ({ name: row.region, count: Number(row.count) }));
  }

  /**
   * 물건 → 사건으로 조인해 그 사건의 사진 메타를 돌려준다 (사진은 사건 단위 — 008_item_photos.sql).
   * 물건이 없으면 null, 사진이 없으면 빈 배열. 현장 전경(ITEM)이 먼저 보이도록 ITEM → APPRAISAL 순으로 정렬한다.
   */
  async findPhotos(
    courtOfficeCode: string,
    caseNo: string,
    itemNo: string,
  ): Promise<AuctionCasePhotoDto[] | null> {
    const itemResult = await this.pool.query<CaseIdRow>(
      `SELECT ac.id AS "caseId"
       FROM auction_item ai
       JOIN auction_case ac ON ac.id = ai.auction_case_id
       WHERE ac.court_office_code = $1 AND ac.case_no = $2 AND ai.item_no = $3`,
      [courtOfficeCode, caseNo, itemNo],
    );
    const caseId = itemResult.rows[0]?.caseId;
    if (caseId === undefined) return null;

    const photoResult = await this.pool.query<PhotoMetaRow>(
      `SELECT id, source, seq,
              category_name AS "categoryName",
              caption,
              content_type AS "contentType",
              byte_size AS "byteSize"
       FROM auction_case_photo
       WHERE auction_case_id = $1
       ORDER BY CASE WHEN source = 'ITEM' THEN 0 ELSE 1 END, seq`,
      [caseId],
    );
    return photoResult.rows.map((row) => ({ ...row, id: Number(row.id) }));
  }

  /**
   * 매각물건명세서 기반 권리분석 — 등기부 없이 계산한다 (WP-04 CODEF 연동 전).
   *
   * 명세서를 아직 못 받은 물건은 null. "인수할 권리가 없다"와 구분해야 하므로 빈 결과를
   * 돌려주지 않는다. 가장 최근에 작성된 명세서 한 건만 본다 — 기일이 바뀌면 새로 작성된다.
   *
   * 성명(tenant_name)은 SELECT에 넣지 않는다 — 응답에 섞여 나갈 경로 자체를 만들지 않는다.
   */
  async findNoticeAnalysis(
    courtOfficeCode: string,
    caseNo: string,
    itemNo: string,
  ): Promise<NoticeAnalysisDto | null> {
    const noticeResult = await this.pool.query<NoticeRow>(
      `SELECT n.id,
              n.document_date AS "documentDate",
              n.baseline_raw AS "baselineRaw",
              n.baseline_date AS "baselineDate",
              n.distribution_demand_deadline AS "distributionDemandDeadline",
              n.assumed_rights_kind AS "assumedRightsKind",
              n.risk_flags AS "riskFlags"
       FROM auction_item_notice n
       JOIN auction_item ai ON ai.id = n.auction_item_id
       JOIN auction_case ac ON ac.id = ai.auction_case_id
       WHERE ac.court_office_code = $1 AND ac.case_no = $2 AND ai.item_no = $3
       ORDER BY n.document_date DESC NULLS LAST, n.observed_at DESC
       LIMIT 1`,
      [courtOfficeCode, caseNo, itemNo],
    );
    const notice = noticeResult.rows[0];
    if (notice === undefined) return null;

    const tenantResult = await this.pool.query<NoticeTenantRow>(
      `SELECT tenant_seq AS "tenantSeq",
              -- 보증기관이 신고한 행인지만 계산해 넘긴다. **성명 자체는 SELECT하지 않는다** —
              -- 응답에 섞여 나갈 경로를 만들지 않는다는 이 파일의 결정을 지키면서, 대위 판정에
              -- 필요한 사실만 얻는다. 한국토지주택공사는 넣지 않는다(전세임대는 LH가 본인 임차인이다).
              (tenant_name ~ '(주택도시보증공사|한국주택금융공사|서울보증)') AS "isGuarantor",
              source_kind AS "sourceKind",
              occupied_part AS "occupiedPart",
              move_in_date AS "moveInDate",
              fixed_date AS "fixedDate",
              deposit_amount AS "depositAmount",
              demanded_distribution AS "demandedDistribution",
              demanded_distribution_date AS "demandedDistributionDate"
       FROM auction_item_notice_tenant
       WHERE notice_id = $1
       ORDER BY row_no`,
      [notice.id],
    );

    const baselineDate = toIsoDate(notice.baselineDate);
    const deadline = toIsoDate(notice.distributionDemandDeadline);

    return {
      documentDate: toIsoDate(notice.documentDate),
      baselineRaw: notice.baselineRaw,
      baselineDate,
      distributionDemandDeadline: deadline,
      assumedRightsKind: notice.assumedRightsKind,
      riskFlags: notice.riskFlags ?? [],
      // 정보출처별로 흩어진 행을 사람 단위로 합친 뒤 판정한다 — 한 행만 골라 보면
      // 다른 행에만 있는 보증금·배당요구를 버리게 된다.
      // 보증기관이 대위한 보증금은 한 채권이다 — 원 임차인과 보증기관을 두 사람으로 세면
      // 없는 임차인 때문에 "N억 이상"이 붙거나 금액이 두 배가 된다 (실측 1,578건)
      tenants: mergeSuccessions(
        mergeNoticeTenants(
        tenantResult.rows.map((row) => ({
          tenantSeq: row.tenantSeq,
          isGuarantor: row.isGuarantor ?? false,
          sourceKind: row.sourceKind,
          occupiedPart: row.occupiedPart,
          moveInDate: toIsoDate(row.moveInDate),
          fixedDate: toIsoDate(row.fixedDate),
          depositAmount: row.depositAmount === null ? null : Number(row.depositAmount),
          demandedDistribution: row.demandedDistribution,
          demandedDistributionDate: toIsoDate(row.demandedDistributionDate),
        })),
        ),
      ).map((tenant) => {
        const verdict = classifyNoticeAssumption(tenant, baselineDate, deadline);
        return {
          ...tenant,
          possessionRightDate: verdict.possessionRightDate,
          hasPriority: verdict.hasPriority,
          distributionDemandEffective: verdict.distributionDemandEffective,
          assumption: verdict.assumption,
          assumedAmount: verdict.assumedAmount,
        };
      }),
      source: 'NOTICE_ONLY',
    };
  }

  /**
   * 실부담 시나리오 — 명세서가 없으면 null (인수액을 알 수 없어 시나리오가 성립하지 않는다).
   * 유사 낙찰가율은 백테스트와 같은 정의(관측 창·비일괄·용도 첫 조각)를 쓴다.
   */
  async findAffordability(
    courtOfficeCode: string,
    caseNo: string,
    itemNo: string,
    customBidPrice: number | null,
  ): Promise<AffordabilityDto | null> {
    const itemResult = await this.pool.query<AffordabilityItemRow>(
      `SELECT ai.appraisal_amount AS "appraisalAmount",
              ai.minimum_sale_price AS "minimumSalePrice",
              split_part(raw.payload->>'dspslUsgNm', ',', 1) AS "usageName",
              (COALESCE(raw.payload->>'mulBigo', '') LIKE '%일괄%') AS "bulkSale"
       FROM auction_item ai
       JOIN auction_case ac ON ac.id = ai.auction_case_id
       LEFT JOIN LATERAL (
         SELECT payload FROM auction_item_raw
         WHERE auction_item_id = ai.id ORDER BY observed_at DESC LIMIT 1
       ) raw ON true
       WHERE ac.court_office_code = $1 AND ac.case_no = $2 AND ai.item_no = $3`,
      [courtOfficeCode, caseNo, itemNo],
    );
    const item = itemResult.rows[0];
    if (item === undefined) return null;

    const analysis = await this.findNoticeAnalysis(courtOfficeCode, caseNo, itemNo);
    if (analysis === null) return null;

    const usage = item.usageName === null || item.usageName === '' ? null : item.usageName;
    return computeAffordability({
      appraisalAmount: item.appraisalAmount === null ? null : Number(item.appraisalAmount),
      minimumSalePrice: item.minimumSalePrice === null ? null : Number(item.minimumSalePrice),
      bulkSale: item.bulkSale,
      usageName: usage,
      tenants: analysis.tenants,
      comparableSales: await this.comparableSaleStats(usage),
      customBidPrice,
    });
  }

  /** 같은 용도 물건의 실측 낙찰가율(감정가 대비 %) 분포 — 관측 창 안·비일괄만 (WP-11 §4-2·§4-20) */
  private async comparableSaleStats(usage: string | null): Promise<ComparableSaleStatsDto> {
    const empty: ComparableSaleStatsDto = {
      usage,
      sampleCount: 0,
      rateP25: null,
      rateMedian: null,
      rateP75: null,
    };
    if (usage === null) return empty;

    const result = await this.pool.query<ComparableStatsRow>(
      `WITH raw AS (
         SELECT DISTINCT ON (auction_item_id) auction_item_id, payload
         FROM auction_item_raw ORDER BY auction_item_id, observed_at DESC
       )
       SELECT count(*)::int AS "sampleCount",
              round(percentile_cont(0.25) WITHIN GROUP (ORDER BY s.rate)::numeric, 1) AS "rateP25",
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.rate)::numeric, 1) AS "rateMedian",
              round(percentile_cont(0.75) WITHIN GROUP (ORDER BY s.rate)::numeric, 1) AS "rateP75"
       FROM (
         SELECT r.sale_amount::numeric / NULLIF(i.appraisal_amount, 0) * 100 AS rate
         FROM auction_sale_result r
         JOIN auction_item i ON i.id = r.auction_item_id
         JOIN raw ON raw.auction_item_id = i.id
         WHERE r.result_code = '001' AND r.sale_amount IS NOT NULL
           AND r.dxdy_date >= $2::date
           AND COALESCE(raw.payload->>'mulBigo', '') NOT LIKE '%일괄%'
           AND split_part(raw.payload->>'dspslUsgNm', ',', 1) = $1
           AND i.appraisal_amount IS NOT NULL
       ) s`,
      [usage, OBSERVED_FROM],
    );
    const row = result.rows[0];
    if (row === undefined || Number(row.sampleCount) === 0) return empty;
    return {
      usage,
      sampleCount: Number(row.sampleCount),
      rateP25: row.rateP25 === null ? null : Number(row.rateP25),
      rateMedian: row.rateMedian === null ? null : Number(row.rateMedian),
      rateP75: row.rateP75 === null ? null : Number(row.rateP75),
    };
  }

  /** 사진 바이너리 단건 조회 — 이미지 응답용. 없으면 null */
  async findPhotoBytes(id: string): Promise<{ contentType: string | null; bytes: Buffer } | null> {
    const result = await this.pool.query<PhotoBytesRow>(
      `SELECT content_type AS "contentType", bytes FROM auction_case_photo WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? { contentType: row.contentType, bytes: row.bytes } : null;
  }

  /**
   * 매각물건명세서 PDF 원본 — 권리분석 화면에서 사용자가 파싱 결과를 원문과 대조하는 데 쓴다.
   *
   * 여러 기일의 명세서가 쌓일 수 있어 최신 작성분을 준다. PDF를 못 받은 명세서(텍스트 레이어로
   * 읽었거나 019 이전 수집분)와 배당종결로 지워진 것은 null이다.
   */
  async findNoticePdf(
    courtOfficeCode: string,
    caseNo: string,
    itemNo: string,
  ): Promise<{ bytes: Buffer; documentDate: Date | null } | null> {
    const result = await this.pool.query<NoticePdfRow>(
      `SELECT n.pdf_bytes AS bytes, n.document_date AS "documentDate"
         FROM auction_item_notice n
         JOIN auction_item ai ON ai.id = n.auction_item_id
         JOIN auction_case ac ON ac.id = ai.auction_case_id
        WHERE ac.court_office_code = $1 AND ac.case_no = $2 AND ai.item_no = $3
          AND n.pdf_bytes IS NOT NULL
        ORDER BY n.document_date DESC NULLS LAST
        LIMIT 1`,
      [courtOfficeCode, caseNo, itemNo],
    );
    const row = result.rows[0];
    return row ? { bytes: row.bytes, documentDate: row.documentDate } : null;
  }

  /** 지도 뷰포트(경위도 사각형) 안의 물건을 찾는다 — 지도 홈(F-01, RN)의 팬/줌 갱신용 */
  async findItemsInBbox(bbox: Bbox, limit: number): Promise<AuctionItemDto[]> {
    const result = await this.pool.query<AuctionItemRow>(
      `${SELECT_AND_FROM}
       WHERE ai.geom IS NOT NULL
         AND ST_Intersects(ai.geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
       ORDER BY ai.updated_at DESC
       LIMIT $5`,
      [bbox.minLng, bbox.minLat, bbox.maxLng, bbox.maxLat, limit],
    );
    return this.withAssumedDeposit(result.rows);
  }
}
