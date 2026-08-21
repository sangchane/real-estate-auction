// 등기부 열람 엔드포인트 — 조회(무료)와 발급(유료)을 **다른 메서드로 나눈다**.
//
// GET은 이미 보관하고 있는 것만 돌려주고 절대 발급하지 않는다. POST만 돈을 쓴다.
// 같은 URL을 GET으로 두 번 열었다고 1,400원이 나가는 일은 없어야 하고, 화면이 무심코
// 프리페치해도 과금되지 않아야 한다 (D-008 — on-demand 원가 통제).
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { parseItemAddress } from './address/parse-item-address';
import type { ItemKey } from './cache/registry-item-key';
import {
  buildRegistryLookupRequest,
  type RegistryLookupAddress,
} from './client/registry-lookup-request';
import {
  AmbiguousAddressCandidateError,
  UnsupportedTwoWayMethodError,
} from './client/codef-two-way';
import {
  CODEF_REGISTRY_SERVICE,
  REGISTRY_CONFIG,
  type RegistryLookupConfig,
} from './registry.tokens';
import type { CodefRegistryService } from './service/codef-registry.service';
import { AuctionItemsRepository } from '../auction-items/auction-items.repository';
import type { RegisteredRightDto } from '../rights-analysis/dto/registered-right.dto';

interface RegistryStateDto {
  /** FETCHED = 보관본이 있다 / NOT_FETCHED = 아직 안 받았다 / UNAVAILABLE = 받을 수 없다 */
  status: 'FETCHED' | 'NOT_FETCHED' | 'UNAVAILABLE';
  registeredRights: RegisteredRightDto[] | null;
  fetchedAt: string | null;
  /** 발급하면 무엇을 조회하게 되는지 — 사용자가 돈을 쓰기 전에 확인할 값이다 */
  lookupPreview: string | null;
  /** 지금 발급할 수 없다면 그 이유 (해요체, 화면에 그대로 노출) */
  reason: string | null;
}

@Controller('auction-items/:courtOfficeCode/:caseNo/:itemNo/registry')
export class RegistryController {
  constructor(
    @Inject(CODEF_REGISTRY_SERVICE) private readonly service: CodefRegistryService,
    @Inject(REGISTRY_CONFIG) private readonly config: RegistryLookupConfig,
    private readonly items: AuctionItemsRepository,
  ) {}

  /** 보관본 조회 — 발급하지 않으므로 돈이 나가지 않는다. */
  @Get()
  async state(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
  ): Promise<RegistryStateDto> {
    const key: ItemKey = { courtOfficeCode, caseNo, itemNo };
    const stored = await this.service.getStored(key);
    if (stored) {
      return {
        status: 'FETCHED',
        registeredRights: stored.registeredRights,
        fetchedAt: stored.fetchedAt.toISOString(),
        lookupPreview: null,
        reason: null,
      };
    }

    // 아직 안 받았다면, 받을 수 있는지와 무엇을 조회하게 되는지를 미리 알려준다.
    const blocked = this.blockedReason();
    if (blocked) {
      return { status: 'UNAVAILABLE', registeredRights: null, fetchedAt: null, lookupPreview: null, reason: blocked };
    }

    const item = await this.items.findOne(courtOfficeCode, caseNo, itemNo);
    if (!item) throw new NotFoundException('물건을 찾을 수 없어요.');

    const parsed = parseItemAddress(item.address ?? '');
    if (!parsed.ok) {
      return {
        status: 'UNAVAILABLE',
        registeredRights: null,
        fetchedAt: null,
        lookupPreview: null,
        reason: parsed.reason,
      };
    }

    return {
      status: 'NOT_FETCHED',
      registeredRights: null,
      fetchedAt: null,
      lookupPreview: describeLookup(parsed.address),
      reason: null,
    };
  }

  /**
   * 등기부 발급 — **여기서 700원이 나간다.** 보관본이 있으면 재사용하므로 두 번 눌러도
   * 한 번만 과금된다.
   */
  @Post()
  async fetch(
    @Param('courtOfficeCode') courtOfficeCode: string,
    @Param('caseNo') caseNo: string,
    @Param('itemNo') itemNo: string,
  ): Promise<RegistryStateDto> {
    const key: ItemKey = { courtOfficeCode, caseNo, itemNo };

    const blocked = this.blockedReason();
    if (blocked) throw new ServiceUnavailableException(blocked);

    const item = await this.items.findOne(courtOfficeCode, caseNo, itemNo);
    if (!item) throw new NotFoundException('물건을 찾을 수 없어요.');

    const parsed = parseItemAddress(item.address ?? '');
    if (!parsed.ok) throw new BadRequestException(parsed.reason);

    const credentials = this.config.credentials;
    if (!credentials) throw new ServiceUnavailableException('등기부 열람 설정이 없어요.');

    const request = buildRegistryLookupRequest(
      { kind: 'ADDRESS', address: parsed.address },
      {
        applicantPhoneNo: credentials.phoneNo,
        // 재열람용 4자리 PIN — 이 조회 건에만 쓰이는 값이라 매번 새로 만든다.
        retrievalPin: randomPin(),
        ePrepay: { no: credentials.ePrepayNo, pass: credentials.ePrepayPass },
      },
      credentials.publicKey,
    );

    try {
      const result = await this.service.getRegisteredRights(randomUUID(), { item: key, request });
      return {
        status: 'FETCHED',
        registeredRights: result.registeredRights,
        fetchedAt: result.fetchedAt.toISOString(),
        lookupPreview: null,
        reason: null,
      };
    } catch (error) {
      // 주소가 여러 건에 걸리면 어느 것인지 우리가 고를 수 없다. 임의로 고르면 700원을 쓰고
      // 남의 등기부를 받는다 — 사용자에게 돌려주고 멈춘다.
      if (error instanceof AmbiguousAddressCandidateError) {
        throw new BadRequestException(
          `이 주소로 부동산이 ${error.candidates.length}건 검색돼서 어느 것인지 고를 수 없어요. 등기부를 받지 않았어요.`,
        );
      }
      if (error instanceof UnsupportedTwoWayMethodError) {
        throw new ServiceUnavailableException('추가 인증이 필요한 물건이라 자동으로 받을 수 없어요.');
      }
      throw error;
    }
  }

  /** 열람 자체가 불가능한 상태인지 — 자격증명이 없으면 호출 자체를 하지 않는다. */
  private blockedReason(): string | null {
    if (!this.config.credentials) {
      return `등기부 열람 설정이 아직 없어요 (빠진 값: ${this.config.missing.join(', ')}).`;
    }
    return null;
  }
}

/** 사용자가 700원을 쓰기 전에 "무엇을 조회하는지" 눈으로 확인할 한 줄 */
function describeLookup(address: RegistryLookupAddress): string {
  return [
    address.sido,
    address.sigungu,
    address.administrativeDong,
    address.lotNumber,
    address.roadName,
    address.buildingNumber,
    address.buildingName,
    address.unitDong,
    address.unitHo,
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}

/** 재열람 PIN — 인터넷등기소 로그인 비밀번호가 아니라 이 건에만 쓰는 4자리 숫자다 */
function randomPin(): string {
  return String(randomInt(1000, 10000));
}
