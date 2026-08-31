// 개발구역 조회 모듈 — DATABASE_URL로 pg Pool을 만들어 리포지토리에 주입한다 (기존 모듈과 동일 패턴)
import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../auction-items/auction-items.repository';
import { loadEnv } from '../config/env';
import { ZonesController } from './zones.controller';
import { ZonesRepository } from './zones.repository';

@Module({
  controllers: [ZonesController],
  providers: [
    {
      provide: PG_POOL,
      useFactory: () => new Pool({ connectionString: loadEnv(process.env).DATABASE_URL }),
    },
    ZonesRepository,
  ],
})
export class ZonesModule {}
