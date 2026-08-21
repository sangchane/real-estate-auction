// 등기부 열람 결과를 DB에 보관·조회한다 — 열람 1건에 700원이 나가므로 재시작해도 잃으면 안 된다.
//
// 메모리 캐시(`registry-request-cache.ts`)는 동시 요청 dedup을 계속 담당하고, 이 리포지토리는
// 프로세스 수명을 넘는 보관을 담당한다. 둘은 대체 관계가 아니라 층이 다르다.
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../auction-items/auction-items.repository';
import type { RegisteredRightDto } from '../../rights-analysis/dto/registered-right.dto';
import type { ItemKey } from './registry-item-key';

export interface StoredRegistryLookup {
  registeredRights: RegisteredRightDto[];
  uniqueNo: string | null;
  fetchedAt: Date;
}

@Injectable()
export class RegistryLookupRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async find(key: ItemKey): Promise<StoredRegistryLookup | null> {
    const { rows } = await this.pool.query<{
      registeredRights: RegisteredRightDto[];
      uniqueNo: string | null;
      fetchedAt: Date;
    }>(
      `SELECT r.registered_rights AS "registeredRights",
              r.unique_no         AS "uniqueNo",
              r.fetched_at        AS "fetchedAt"
         FROM registry_lookup r
         JOIN auction_item i ON i.id = r.auction_item_id
         JOIN auction_case c ON c.id = i.auction_case_id
        WHERE c.court_office_code = $1 AND c.case_no = $2 AND i.item_no = $3`,
      [key.courtOfficeCode, key.caseNo, key.itemNo],
    );
    return rows[0] ?? null;
  }

  /**
   * 같은 물건을 다시 열람했으면 덮어쓴다 — 등기부는 시점 스냅샷이라 최신 것만 의미가 있다.
   * 물건을 못 찾으면 아무 행도 만들지 않는다(0을 돌려준다) — 없는 물건에 등기부가 달리면
   * 어느 화면에서도 다시 꺼낼 수 없다.
   */
  async save(
    key: ItemKey,
    rights: RegisteredRightDto[],
    uniqueNo: string | null,
  ): Promise<number> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO registry_lookup (auction_item_id, registered_rights, unique_no)
       SELECT i.id, $4::jsonb, $5
         FROM auction_item i
         JOIN auction_case c ON c.id = i.auction_case_id
        WHERE c.court_office_code = $1 AND c.case_no = $2 AND i.item_no = $3
       ON CONFLICT (auction_item_id) DO UPDATE
          SET registered_rights = EXCLUDED.registered_rights,
              unique_no         = COALESCE(EXCLUDED.unique_no, registry_lookup.unique_no),
              fetched_at        = now()`,
      [key.courtOfficeCode, key.caseNo, key.itemNo, JSON.stringify(rights), uniqueNo],
    );
    return rowCount ?? 0;
  }
}
