// 개발구역 조회 컨트롤러 — 지도 뷰포트가 구역 폴리곤 레이어를 받아가는 읽기 전용 엔드포인트
import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { Bbox } from '../auction-items/dto/bbox.dto';
import type { ZoneFeatureCollectionDto } from './dto/zone-feature.dto';
import { ZonesRepository } from './zones.repository';

// 한 응답에 실을 구역 수 상한(설계 05 EP-1). 뷰포트를 아무리 넓혀도 응답이 무한정 커지지 않게 막는다.
export const ZONE_FEATURE_LIMIT = 1000;

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
}
