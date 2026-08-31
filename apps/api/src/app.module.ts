// 루트 모듈 — 도메인 모듈이 추가되면 여기에 등록한다
import { Module } from '@nestjs/common';
import { AuctionItemsModule } from './auction-items/auction-items.module';
import { AuthModule } from './auth/auth.module';
import { BacktestModule } from './backtest/backtest.module';
import { FavoritesModule } from './favorites/favorites.module';
import { HealthController } from './health/health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { RegistryModule } from './codef-registry/registry.module';
import { ZonesModule } from './zones/zones.module';

@Module({
  imports: [
    AuctionItemsModule,
    AuthModule,
    BacktestModule,
    FavoritesModule,
    NotificationsModule,
    RegistryModule,
    ZonesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
