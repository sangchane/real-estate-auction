import { Logger } from '@nestjs/common';
import { RegistryRequestCache } from '../cache/registry-request-cache';
import type { StoredRegistryLookup } from '../cache/registry-lookup.repository';
import type { CodefRegistryClient, CodefRegistryRawResponse } from '../client/codef-registry.client';
import {
  CodefRegistryService,
  type RegistryLookupResult,
  type RegistryLookupStore,
  type RegistryResponseMapper,
} from './codef-registry.service';

function fakeClient(raw: CodefRegistryRawResponse): CodefRegistryClient {
  return { lookupWithTwoWay: jest.fn().mockResolvedValue(raw) } as unknown as CodefRegistryClient;
}

/** 메모리 보관본 — DB 리포지토리와 같은 계약을 지킨다 */
function fakeStore(seed?: StoredRegistryLookup): RegistryLookupStore & { saved: number } {
  let held = seed ?? null;
  return {
    saved: 0,
    find: jest.fn(async () => held),
    save: jest.fn(async function (this: { saved: number }, _key, rights, uniqueNo) {
      held = { registeredRights: rights, uniqueNo, fetchedAt: new Date('2026-08-21T00:00:00Z') };
      return 1;
    }),
  } as unknown as RegistryLookupStore & { saved: number };
}

const SUCCESS_RAW: CodefRegistryRawResponse = { result: { code: 'CF-00000', message: 'ok' }, data: {} };
const FAKE_RIGHTS = [{ id: 'r1', type: 'MORTGAGE' as const, receivedDate: '2024-01-01' }];
const identityMapper: RegistryResponseMapper = () => FAKE_RIGHTS;
const ITEM = { courtOfficeCode: 'B000210', caseNo: '2024타경1', itemNo: '1' };

function makeService(client: CodefRegistryClient, store: RegistryLookupStore) {
  return new CodefRegistryService(
    new RegistryRequestCache<RegistryLookupResult>(),
    client,
    identityMapper,
    store,
  );
}

describe('CodefRegistryService', () => {
  it('첫 조회는 실제 클라이언트를 호출해 매핑 결과를 반환한다', async () => {
    const client = fakeClient(SUCCESS_RAW);
    const service = makeService(client, fakeStore());

    const result = await service.getRegisteredRights('req-1', { item: ITEM, request: {} });

    expect(result.registeredRights).toEqual(FAKE_RIGHTS);
    expect(result.billed).toBe(true);
    expect(client.lookupWithTwoWay).toHaveBeenCalledTimes(1);
  });

  it('같은 물건을 재조회하면 캐시를 사용해 외부 호출이 0회다', async () => {
    const client = fakeClient(SUCCESS_RAW);
    const service = makeService(client, fakeStore());
    const params = { item: ITEM, request: {} };

    await service.getRegisteredRights('req-1', params);
    await service.getRegisteredRights('req-2', params);

    expect(client.lookupWithTwoWay).toHaveBeenCalledTimes(1);
  });

  it('보관본이 있으면 발급하지 않는다 — 재시작해도 700원이 다시 나가면 안 된다', async () => {
    // 프로세스가 새로 뜬 상황: 메모리 캐시는 비어 있고 DB에만 남아 있다
    const client = fakeClient(SUCCESS_RAW);
    const stored: StoredRegistryLookup = {
      registeredRights: FAKE_RIGHTS,
      uniqueNo: '1234-5678',
      fetchedAt: new Date('2026-08-01T00:00:00Z'),
    };
    const service = makeService(client, fakeStore(stored));

    const result = await service.getRegisteredRights('req-1', { item: ITEM, request: {} });

    expect(client.lookupWithTwoWay).not.toHaveBeenCalled();
    expect(result.billed).toBe(false);
    expect(result.fetchedAt).toEqual(stored.fetchedAt);
  });

  it('발급한 등기부는 보관한다 — 보관하지 않으면 다음 조회에서 또 과금된다', async () => {
    const client = fakeClient(SUCCESS_RAW);
    const store = fakeStore();
    const service = makeService(client, store);

    await service.getRegisteredRights('req-1', { item: ITEM, request: {} });

    expect(store.save).toHaveBeenCalledWith(ITEM, FAKE_RIGHTS, null);
  });

  it('같은 물건을 동시에 조회해도 외부 호출은 1회만 발생한다', async () => {
    const client = fakeClient(SUCCESS_RAW);
    const service = makeService(client, fakeStore());
    const params = { item: ITEM, request: {} };

    await Promise.all([
      service.getRegisteredRights('req-1', params),
      service.getRegisteredRights('req-2', params),
    ]);

    expect(client.lookupWithTwoWay).toHaveBeenCalledTimes(1);
  });

  it('같은 사건의 다른 물건은 별개로 발급한다 — 등기부가 서로 다른 부동산이다', async () => {
    // 사건 단위로 캐시하면 2번 물건에 1번 물건의 등기부가 붙는다 (실측 361건/3,083건)
    const client = fakeClient(SUCCESS_RAW);
    const service = makeService(client, {
      find: jest.fn(async () => null),
      save: jest.fn(async () => 1),
    });

    await service.getRegisteredRights('req-1', { item: ITEM, request: {} });
    await service.getRegisteredRights('req-2', { item: { ...ITEM, itemNo: '2' }, request: {} });

    expect(client.lookupWithTwoWay).toHaveBeenCalledTimes(2);
  });

  it('동시 요청 중 실제로 발급을 호출한 한쪽만 billed=true로 로그된다', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const client = fakeClient(SUCCESS_RAW);
    const service = makeService(client, fakeStore());
    const params = { item: ITEM, request: {} };

    await Promise.all([
      service.getRegisteredRights('req-1', params),
      service.getRegisteredRights('req-2', params),
    ]);

    const successLogs = logSpy.mock.calls.map((call) => String(call[0])).filter((m) => m.includes('success'));
    const billedTrueCount = successLogs.filter((m) => m.includes('billed=true')).length;
    const billedFalseCount = successLogs.filter((m) => m.includes('billed=false')).length;

    expect(billedTrueCount).toBe(1);
    expect(billedFalseCount).toBe(1);
    logSpy.mockRestore();
  });

  it('보관에 실패하면 경고를 남긴다 — 조용히 넘어가면 과금이 새는 것을 못 본다', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const client = fakeClient(SUCCESS_RAW);
    const service = makeService(client, {
      find: jest.fn(async () => null),
      save: jest.fn(async () => 0), // 물건을 못 찾음
    });

    await service.getRegisteredRights('req-1', { item: ITEM, request: {} });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('codef_registry_store_miss'));
    warnSpy.mockRestore();
  });

  it('클라이언트 오류는 그대로 전파하고 캐시에 남기지 않는다', async () => {
    const client = {
      lookupWithTwoWay: jest.fn().mockRejectedValue(new Error('일시 오류')),
    } as unknown as CodefRegistryClient;
    const service = makeService(client, fakeStore());

    await expect(
      service.getRegisteredRights('req-1', { item: ITEM, request: {} }),
    ).rejects.toThrow('일시 오류');
  });

  it('getStored는 절대 발급하지 않는다 — 화면이 무료로 물어볼 수 있어야 한다', async () => {
    const client = fakeClient(SUCCESS_RAW);
    const service = makeService(client, fakeStore());

    expect(await service.getStored(ITEM)).toBeNull();
    expect(client.lookupWithTwoWay).not.toHaveBeenCalled();
  });
});
