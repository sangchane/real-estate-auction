// 등기부 커넥터 오케스트레이션 — 보관본 확인 → (없을 때만) 발급 → 매핑 → 보관, 요청ID·물건키·과금여부 로깅.
// 응답 매핑(mapResponse)은 실제 CODEF 응답 스펙에 의존하므로 이 서비스에 하드코딩하지 않고 주입받는다.
//
// **열람 1건에 700원이 실제로 나간다** (D-008). 그래서 캐시가 두 층이다:
//   1) 보관본(store) — DB. 프로세스가 재시작돼도 이미 산 등기부를 다시 사지 않는다.
//   2) in-flight dedup(cache) — 메모리. 같은 물건이 동시에 요청돼도 발급은 1회다.
// 메모리 층만 있던 때는 배포할 때마다 캐시가 통째로 사라져 같은 등기부를 다시 샀다.
import { Logger } from '@nestjs/common';
import type { RegisteredRightDto } from '../../rights-analysis/dto/registered-right.dto';
import type { ItemKey } from '../cache/registry-item-key';
import { registryCacheKey } from '../cache/registry-item-key';
import type { StoredRegistryLookup } from '../cache/registry-lookup.repository';
import type { RegistryRequestCache } from '../cache/registry-request-cache';
import type { CodefTwoWayContinuation } from '../client/codef-two-way';
import { resolveSingleAddressCandidate } from '../client/codef-two-way';
import type {
  CodefRegistryClient,
  CodefRegistryLookupRequest,
  CodefRegistryRawResponse,
} from '../client/codef-registry.client';

export type RegistryResponseMapper = (raw: CodefRegistryRawResponse) => RegisteredRightDto[];

/** DB 보관본 접근 — 테스트가 가짜를 넣을 수 있게 인터페이스로 받는다 */
export interface RegistryLookupStore {
  find(key: ItemKey): Promise<StoredRegistryLookup | null>;
  save(key: ItemKey, rights: RegisteredRightDto[], uniqueNo: string | null): Promise<number>;
}

export interface CodefRegistryLookupParams {
  /** 캐시·보관 키는 **물건** 단위다 — 한 사건의 여러 물건은 서로 다른 부동산이다 */
  item: ItemKey;
  request: CodefRegistryLookupRequest;
}

export interface RegistryLookupResult {
  registeredRights: RegisteredRightDto[];
  /** 이 등기부를 열람한 시각 — 화면에 그대로 보여준다. 최신이라고 말하지 않기 위해서다 */
  fetchedAt: Date;
  /** 이번 호출에서 실제로 700원이 나갔는지 */
  billed: boolean;
}

export class CodefRegistryService {
  private readonly logger = new Logger(CodefRegistryService.name);

  constructor(
    private readonly cache: RegistryRequestCache<RegistryLookupResult>,
    private readonly client: CodefRegistryClient,
    private readonly mapResponse: RegistryResponseMapper,
    private readonly store: RegistryLookupStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 보관본만 본다 — 없으면 null. 절대 발급하지 않으므로 돈이 나가지 않는다. */
  async getStored(key: ItemKey): Promise<StoredRegistryLookup | null> {
    return this.store.find(key);
  }

  async getRegisteredRights(
    requestId: string,
    params: CodefRegistryLookupParams,
  ): Promise<RegistryLookupResult> {
    const key = registryCacheKey(params.item);
    this.logger.log(`codef_registry_lookup_start requestId=${requestId} item=${key}`);

    // 보관본이 있으면 여기서 끝난다 — 발급 호출도, 과금도 없다.
    const stored = await this.store.find(params.item);
    if (stored) {
      this.logger.log(
        `codef_registry_lookup_success requestId=${requestId} item=${key} billed=false source=store rightCount=${stored.registeredRights.length}`,
      );
      return {
        registeredRights: stored.registeredRights,
        fetchedAt: stored.fetchedAt,
        billed: false,
      };
    }

    // fetcher가 실제로 실행된 호출만 CODEF에 발급을 요청한 것이다 — 동시 요청 dedup으로
    // 재사용된 호출은 fetcher가 실행되지 않으므로 billed=false로 정확히 기록된다.
    let billed = false;

    try {
      const result = await this.cache.getOrFetch(key, async () => {
        billed = true;

        // 2-Way 주소 후보 해소 과정에서 정해지는 부동산 고유번호를 붙잡아 둔다.
        // 다음 열람 때 주소 검색 왕복을 건너뛸 수 있다.
        let uniqueNo: string | null = null;
        const raw = await this.client.lookupWithTwoWay(
          params.request,
          (continuation: CodefTwoWayContinuation) => {
            uniqueNo = resolveSingleAddressCandidate(continuation);
            return uniqueNo;
          },
        );

        const registeredRights = this.mapResponse(raw);
        const saved = await this.store.save(params.item, registeredRights, uniqueNo);
        if (saved === 0) {
          // 물건을 못 찾아 보관에 실패했다. 값은 돌려주되, 다음 조회에서 또 700원이 나간다는
          // 사실을 로그로 남긴다 — 조용히 넘어가면 과금이 새는 것을 눈치챌 수 없다.
          this.logger.warn(
            `codef_registry_store_miss requestId=${requestId} item=${key} — 물건을 찾지 못해 보관하지 못했다`,
          );
        }
        return { registeredRights, fetchedAt: this.now(), billed: true };
      });

      this.logger.log(
        `codef_registry_lookup_success requestId=${requestId} item=${key} billed=${billed} rightCount=${result.registeredRights.length}`,
      );
      return { ...result, billed };
    } catch (error) {
      this.logger.error(
        `codef_registry_lookup_failure requestId=${requestId} item=${key} error=${(error as Error).message}`,
      );
      throw error;
    }
  }
}
