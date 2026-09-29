import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Integration, RoasSnapshot } from '../database/entities';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { MetaAdsService } from './meta-ads.service';
import { MetaMcpService } from './meta-mcp.service';
import { PipedreamService } from './pipedream.service';
import { RoasService } from './roas.service';
import { SheetsService } from './sheets.service';
import { StripeService } from './stripe.service';
import { RoasController } from './roas.controller';
import { XeroService } from './xero.service';

@Module({
  imports: [TypeOrmModule.forFeature([Integration, RoasSnapshot])],
  controllers: [IntegrationsController, RoasController],
  providers: [
    IntegrationsService,
    PipedreamService,
    MetaMcpService,
    MetaAdsService,
    StripeService,
    SheetsService,
    RoasService,
    XeroService,
  ],
  exports: [
    IntegrationsService,
    PipedreamService,
    MetaMcpService,
    MetaAdsService,
    StripeService,
    SheetsService,
    RoasService,
    XeroService,
  ],
})
export class IntegrationsModule {}
