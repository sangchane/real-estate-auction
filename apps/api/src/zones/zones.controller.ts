// 개발구역 조회 컨트롤러 — 지도 뷰포트가 구역 폴리곤 레이어를 받아가는 읽기 전용 엔드포인트
import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import type { Bbox } from '../auction-items/dto/bbox.dto';
import type { DongBuildingAgeDto } from './dto/building-age.dto';
import type { ZoneFeatureCollectionDto } from './dto/zone-feature.dto';
import type { ItemZoningDistrictDto, ZoningFeatureCollectionDto } from './dto/zoning.dto';
import { ZonesRepository } from './zones.repository';

// 한 응답에 실을 구역 수 상한(설계 05 EP-1). 뷰포트를 아무리 넓혀도 응답이 무한정 커지지 않게 막는다.
export const ZONE_FEATURE_LIMIT = 1000;

// 용도지역 상한 (기획 12 §3.4의 실측 확정 절차). z14 뷰포트 실측(2026-09-01, 밀집 5곳):
// 912~1,934 피처 — 정상 렌더 구간(웹은 z≥14에서만 그린다)이 잘리지 않는 값으로 2,000.
// 상한을 낮춰 512KB를 맞추면 z14 화면 한가운데의 폴리곤이 조용히 빠진다 — 채움 레이어의 구멍은
// "이 자리는 용도지역 없음"이라는 허위 사실이라, 크기는 클립·허용오차로만 줄인다(리포지토리 주석).
// z13 이하 bbox(실측 2,323~5,594)는 잘리지만 그 줌에서는 웹이 레이어 대신 확대 안내를 띄운다.
export const ZONING_FEATURE_LIMIT = 2000;

const BBOX_PART_COUNT = 4;

/**
 * `bbox=minLng,minLat,maxLng,maxLat`를 런타임 검증한다 (AGENTS.md 규칙 21) — TS 타입은 사용자가
 * 보내는 문자열을 막아주지 않는다.
 *
 * 잘못된 값을 조용히 넘기면 빈 FeatureCollection이 돌아가고, 화면은 그것을 "이 동네에 구역이 없다"는
 * 사실로 읽는다. 그래서 의심스러우면 400으로 끊는다.
 */
function parseBbox(value: string | undefined): Bbox {
  if (value === undefined || value === '') {
    throw new BadRequestException('bbox 쿼리 파라미터가 필요해요 (minLng,minLat,maxLng,maxLat)');
  }

  const parts = value.split(',');
  if (parts.length !== BBOX_PART_COUNT) {
    throw new BadRequestException(`bbox는 숫자 4개여야 해요: ${value}`);
  }

  const bbox: Bbox = {
    minLng: parseCoord(parts, 0, value),
    minLat: parseCoord(parts, 1, value),
    maxLng: parseCoord(parts, 2, value),
    maxLat: parseCoord(parts, 3, value),
  };

  // 폭·높이가 0인 사각형도 막는다. 결과가 늘 비어 있어 "구역 없음"과 구분되지 않는다.
  if (bbox.minLng >= bbox.maxLng || bbox.minLat >= bbox.maxLat) {
    throw new BadRequestException(`bbox의 최솟값이 최댓값보다 작아야 해요: ${value}`);
  }

  return bbox;
}

function parseCoord(parts: string[], index: number, value: string): number {
  const part = parts[index]?.trim() ?? '';
  // Number('')는 0이다 — 빈 조각을 통과시키면 좌표 0,0으로 조회된다.
  const parsed = part === '' ? Number.NaN : Number(part);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(`bbox 값이 올바른 숫자가 아니에요: ${value}`);
  }
  return parsed;
}

@Controller('zones')
export class ZonesController {
  constructor(private readonly repository: ZonesRepository) {}

  @Get()
  async zones(@Query('bbox') bbox?: string): Promise<ZoneFeatureCollectionDto> {
    return this.repository.findZonesInBbox(parseBbox(bbox), ZONE_FEATURE_LIMIT);
  }

  /** bbox 안의 용도지역 폴리곤. bbox 검증·truncated 규약은 정비구역(GET /zones)과 같다 */
  @Get('zoning')
  async zoning(@Query('bbox') bbox?: string): Promise<ZoningFeatureCollectionDto> {
    return this.repository.findZoningInBbox(parseBbox(bbox), ZONING_FEATURE_LIMIT);
  }

  /**
   * 물건이 속한 용도지역 사실 목록 (건물 노후도와 같은 물건키 관례). 여러 건이 정상이다 —
   * 원천이 같은 자리의 재고시 폴리곤을 함께 담는다(022 주석). 404는 좌표가 없거나 공간조인
   * 전이라는 뜻이고, 화면은 섹션을 그리지 않는 것으로 응답한다.
   */
  @Get('zoning/:courtOfficeCode/:caseNo/:itemNo')
  async itemZoning(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
  ): Promise<ItemZoningDistrictDto[]> {
    const districts = await this.repository.findZoningForItem(courtOfficeCode, caseNo, itemNo);
    if (districts.length === 0) {
      throw new NotFoundException('이 물건의 용도지역 정보가 아직 없어요');
    }
    return districts;
  }

  /**
   * 물건이 속한 법정동의 노후도 사실. 404는 "물건이 없다"가 아니라 "이 물건에 대해 말할 수 있는
   * 동 집계가 없다"까지 포함한다 — 화면은 섹션을 그리지 않는 것으로 응답한다 (조용한 0% 금지).
   */
  @Get('building-age/:courtOfficeCode/:caseNo/:itemNo')
  async buildingAge(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
  ): Promise<DongBuildingAgeDto> {
    const dto = await this.repository.findBuildingAgeForItem(courtOfficeCode, caseNo, itemNo);
    if (dto === null) {
      throw new NotFoundException('이 물건이 속한 동의 노후도 집계가 아직 없어요');
    }
    return dto;
  }
}
