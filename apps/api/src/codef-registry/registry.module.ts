// 등기부 열람 모듈 — 커넥터(WP-04)를 실제로 호출 가능한 엔드포인트에 배선한다.
//
// 지금까지 커넥터는 완성돼 있었지만 모듈이 없어 app.module에 등록되지 않았고, 그래서
// 호출할 방법 자체가 없었다. 배선하면서 원가 통제를 함께 넣는다:
//   - 보관본(DB)을 먼저 본다 — 재시작해도 이미 산 등기부를 다시 사지 않는다
//   - 자격증명이 없으면 조용히 죽지 않고 엔드포인트만 거절한다 (등기부 없이도 API는 떠야 한다)
import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { AuctionItemsRepository, PG_POOL } from '../auction-items/auction-items.repository';
import { loadEnv } from '../config/env';
import { CodefTokenClient } from './auth/codef-token.client';
import { RegistryLookupRepository } from './cache/registry-lookup.repository';
import { RegistryRequestCache } from './cache/registry-request-cache';
import { CodefRegistryClient } from './client/codef-registry.client';
import { mapRegistryResponseToRegisteredRights } from './mapper/registry-response.mapper';
import { RegistryController } from './registry.controller';
import {
  CODEF_REGISTRY_SERVICE,
  REGISTRY_CONFIG,
  type RegistryLookupConfig,
} from './registry.tokens';
import {
  CodefRegistryService,
  type RegistryLookupResult,
} from './service/codef-registry.service';

/** 어느 키가 비었는지 이름으로 알려주기 위한 목록 — "설정이 없어요"만으로는 못 고친다 */
const MISSING_KEYS = [
  'CODEF_CLIENT_ID',
  'CODEF_CLIENT_SECRET',
  'CODEF_PUBLIC_KEY',
  'IROS_PHONE_NO',
  'IROS_EPREPAY_NO',
  'IROS_EPREPAY_PASS',
] as const;

export function buildRegistryConfig(source: NodeJS.ProcessEnv): RegistryLookupConfig {
  const env = loadEnv(source);
  // 하나라도 비면 전체를 null로 만든다 — 반쯤 채워진 설정으로 호출하면 CODEF가 무엇 때문에
  // 실패했는지 알기 어려운 오류를 돌려준다. 아예 시도하지 않는 편이 낫다.
  const { CODEF_CLIENT_ID, CODEF_CLIENT_SECRET, CODEF_PUBLIC_KEY } = env;
  const { IROS_PHONE_NO, IROS_EPREPAY_NO, IROS_EPREPAY_PASS } = env;
  const complete =
    CODEF_CLIENT_ID !== undefined &&
    CODEF_CLIENT_SECRET !== undefined &&
    CODEF_PUBLIC_KEY !== undefined &&
    IROS_PHONE_NO !== undefined &&
    IROS_EPREPAY_NO !== undefined &&
    IROS_EPREPAY_PASS !== undefined;

  return {
    missing: MISSING_KEYS.filter((key) => env[key] === undefined),
    credentials: complete
      ? {
          phoneNo: IROS_PHONE_NO,
          ePrepayNo: IROS_EPREPAY_NO,
          ePrepayPass: IROS_EPREPAY_PASS,
          publicKey: CODEF_PUBLIC_KEY,
        }
      : null,
    isDemo: !env.CODEF_API_BASE.includes('//api.codef.io'),
  };
}

@Module({
  controllers: [RegistryController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => new Pool({ connectionString: loadEnv(process.env).DATABASE_URL }),
    },
    AuctionItemsRepository,
    RegistryLookupRepository,
    { provide: REGISTRY_CONFIG, useFactory: () => buildRegistryConfig(process.env) },
    {
      provide: CODEF_REGISTRY_SERVICE,
      inject: [RegistryLookupRepository],
      useFactory: (store: RegistryLookupRepository) => {
        const env = loadEnv(process.env);
        const tokenClient = new CodefTokenClient({
          oauthBaseUrl: env.CODEF_OAUTH_BASE,
          clientId: env.CODEF_CLIENT_ID ?? '',
          clientSecret: env.CODEF_CLIENT_SECRET ?? '',
        });
        const client = new CodefRegistryClient({ apiBaseUrl: env.CODEF_API_BASE }, tokenClient);
        return new CodefRegistryService(
          new RegistryRequestCache<RegistryLookupResult>(),
          client,
          mapRegistryResponseToRegisteredRights,
          store,
        );
      },
    },
  ],
})
export class RegistryModule {}
