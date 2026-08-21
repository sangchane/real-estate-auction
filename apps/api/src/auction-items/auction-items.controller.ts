// 물건 조회 컨트롤러 — 목록/단건/지역 집계/지도 뷰포트/사건 사진 읽기 전용 엔드포인트 (WP-02 수집 데이터 소비)
import type { ServerResponse } from 'node:http';
import { BadRequestException, Controller, Get, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { AuctionItemsRepository, type ItemListSort } from './auction-items.repository';
import type { AffordabilityDto } from './dto/affordability.dto';
import type { AuctionCasePhotoDto } from './dto/auction-case-photo.dto';
import type { AuctionItemDto } from './dto/auction-item.dto';
import type { NoticeAnalysisDto } from './dto/notice-analysis.dto';
import type { RegionCountDto } from './dto/region-count.dto';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const BBOX_LIMIT = 500;

const LIST_SORTS: readonly ItemListSort[] = [
  'recent',
  'bidDate',
  'priceAsc',
  'priceDesc',
  'failedDesc',
];

/**
 * 목록 필터 쿼리를 런타임 검증한다. TS 타입은 런타임을 보호하지 않는다(AGENTS.md 규칙 21) —
 * 사용자가 보내는 값이라 여기서 걸러야 SQL 까지 이상한 값이 내려가지 않는다.
 *
 * 잘못된 값은 400으로 막는다. 조용히 무시하면 사용자는 필터가 걸린 줄 알고 잘못된 목록을 본다.
 */
function parseListFilter(query: {
  usage?: string;
  minPrice?: string;
  maxPrice?: string;
  sort?: string;
}): { usages?: string[]; minPrice?: number; maxPrice?: number; sort?: ItemListSort } {
  const usages = query.usage
    ?.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  const minPrice = parsePriceParam('minPrice', query.minPrice);
  const maxPrice = parsePriceParam('maxPrice', query.maxPrice);
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new BadRequestException('minPrice가 maxPrice보다 클 수 없어요');
  }

  let sort: ItemListSort | undefined;
  if (query.sort !== undefined) {
    if (!LIST_SORTS.includes(query.sort as ItemListSort)) {
      throw new BadRequestException(`sort 값이 올바르지 않아요: ${query.sort}`);
    }
    sort = query.sort as ItemListSort;
  }

  return { usages: usages && usages.length > 0 ? usages : undefined, minPrice, maxPrice, sort };
}

function parsePriceParam(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new BadRequestException(`${name} 값이 올바르지 않아요: ${value}`);
  }
  return parsed;
}

function parseBboxParam(name: string, value: string | undefined): number {
  if (value === undefined) {
    throw new BadRequestException(`${name} 쿼리 파라미터가 필요해요`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(`${name} 값이 올바른 숫자가 아니에요: ${value}`);
  }
  return parsed;
}

@Controller('auction-items')
export class AuctionItemsController {
  constructor(private readonly repository: AuctionItemsRepository) {}

  @Get('regions')
  async regions(@Query('sido') sido?: string): Promise<RegionCountDto[]> {
    return sido ? this.repository.countBySigungu(sido) : this.repository.countBySido();
  }

  @Get('bbox')
  async bbox(
    @Query('minLng') minLng?: string,
    @Query('minLat') minLat?: string,
    @Query('maxLng') maxLng?: string,
    @Query('maxLat') maxLat?: string,
  ): Promise<AuctionItemDto[]> {
    return this.repository.findItemsInBbox(
      {
        minLng: parseBboxParam('minLng', minLng),
        minLat: parseBboxParam('minLat', minLat),
        maxLng: parseBboxParam('maxLng', maxLng),
        maxLat: parseBboxParam('maxLat', maxLat),
      },
      BBOX_LIMIT,
    );
  }

  // 상세 라우트(:courtOfficeCode/:caseNo/:itemNo)보다 먼저 선언해야 한다 — NestJS는 선언 순서로 매칭한다
  @Get('photos/:id')
  async photoImage(@Param('id') id: string, @Res() res: ServerResponse): Promise<void> {
    // 숫자가 아닌 id는 DB bigint 캐스팅 에러(500)가 나므로 먼저 걸러 404로 처리한다
    const photo = /^\d+$/.test(id) ? await this.repository.findPhotoBytes(id) : null;
    if (!photo) {
      throw new NotFoundException(`사진을 찾을 수 없어요: ${id}`);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', photo.contentType ?? 'application/octet-stream');
    // 사진은 변하지 않고 바이트가 커서 캐싱이 중요하다 — 하루 캐시 + immutable
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.setHeader('Content-Length', photo.bytes.length);
    res.end(photo.bytes);
  }

  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sido') sido?: string,
    @Query('sigungu') sigungu?: string,
    @Query('usage') usage?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('sort') sort?: string,
  ): Promise<AuctionItemDto[]> {
    const parsedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const parsedOffset = Math.max(Number(offset) || 0, 0);
    return this.repository.findMany(parsedLimit, parsedOffset, {
      sido,
      sigungu,
      ...parseListFilter({ usage, minPrice, maxPrice, sort }),
    });
  }

  /**
   * 같은 조건의 전체 건수. 목록이 "전체 N건"과 남은 페이지를 알 수 있게 한다.
   *
   * 목록과 조건을 반드시 같이 넘겨야 두 숫자가 어긋나지 않는다.
   */
  @Get('count')
  async count(
    @Query('sido') sido?: string,
    @Query('sigungu') sigungu?: string,
    @Query('usage') usage?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
  ): Promise<{ count: number }> {
    const count = await this.repository.countMany({
      sido,
      sigungu,
      ...parseListFilter({ usage, minPrice, maxPrice }),
    });
    return { count };
  }

  @Get(':courtOfficeCode/:caseNo/:itemNo/photos')
  async photos(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
  ): Promise<AuctionCasePhotoDto[]> {
    const photos = await this.repository.findPhotos(courtOfficeCode, caseNo, itemNo);
    if (!photos) {
      throw new NotFoundException(`물건을 찾을 수 없어요: ${courtOfficeCode}/${caseNo}/${itemNo}`);
    }
    return photos;
  }

  @Get(':courtOfficeCode/:caseNo/:itemNo')
  async findOne(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
  ): Promise<AuctionItemDto> {
    const item = await this.repository.findOne(courtOfficeCode, caseNo, itemNo);
    if (!item) {
      throw new NotFoundException(`물건을 찾을 수 없어요: ${courtOfficeCode}/${caseNo}/${itemNo}`);
    }
    return item;
  }

  /**
   * 실부담 시나리오 — 입찰가 가정별 총부담 구간과 감정가 대비 %.
   * bidPrice 쿼리로 직접 입력 시나리오를 추가할 수 있다.
   * 명세서가 없으면 404 — 인수액을 모르는 채 계산하면 "부담 없음"으로 잘못 읽힌다.
   */
  @Get(':courtOfficeCode/:caseNo/:itemNo/affordability')
  async affordability(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
    @Query('bidPrice') bidPrice?: string,
  ): Promise<AffordabilityDto> {
    let customBidPrice: number | null = null;
    if (bidPrice !== undefined) {
      const parsed = Number(bidPrice);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new BadRequestException(`bidPrice 값이 올바른 양수가 아니에요: ${bidPrice}`);
      }
      customBidPrice = Math.round(parsed);
    }
    const result = await this.repository.findAffordability(courtOfficeCode, caseNo, itemNo, customBidPrice);
    if (!result) {
      throw new NotFoundException(`매각물건명세서를 아직 받지 못했어요: ${caseNo} ${itemNo}`);
    }
    return result;
  }

  /**
   * 매각물건명세서 기반 권리분석. 등기부(CODEF, WP-04)가 없어도 대항력 판정과
   * "배당요구를 안 했으면 전액 인수"까지는 확정된다.
   *
   * 명세서를 아직 못 받은 물건은 404 — 빈 결과로 주면 "인수할 권리가 없다"로 읽힌다.
   */
  @Get(':courtOfficeCode/:caseNo/:itemNo/notice-analysis')
  async noticeAnalysis(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
  ): Promise<NoticeAnalysisDto> {
    const analysis = await this.repository.findNoticeAnalysis(courtOfficeCode, caseNo, itemNo);
    if (!analysis) {
      throw new NotFoundException(`매각물건명세서를 아직 받지 못했어요: ${caseNo} ${itemNo}`);
    }
    return analysis;
  }

  /**
   * 매각물건명세서 PDF 원본. 권리분석 화면이 팝업으로 띄워 사용자가 파싱 결과를 원문과 대조한다.
   *
   * 명세서를 받았어도 PDF가 없을 수 있다 — 텍스트 레이어 경로로 읽었거나, 019 이전 수집분이거나,
   * 배당종결로 지워진 경우다. 그때는 404이고 화면은 원문 보기 버튼을 감춘다.
   */
  @Get(':courtOfficeCode/:caseNo/:itemNo/notice-pdf')
  async noticePdf(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const pdf = await this.repository.findNoticePdf(courtOfficeCode, caseNo, itemNo);
    if (!pdf) {
      throw new NotFoundException(`명세서 원문을 찾을 수 없어요: ${caseNo} ${itemNo}`);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    // 브라우저 내장 뷰어로 열리게 한다(inline) — 확대·축소는 그 뷰어가 제공한다
    res.setHeader('Content-Disposition', 'inline');
    // 같은 기일의 명세서는 바뀌지 않는다. 다만 배당종결이면 지워지므로 immutable은 쓰지 않는다
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Length', pdf.bytes.length);
    res.end(pdf.bytes);
  }
}
