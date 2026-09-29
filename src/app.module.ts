import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminModule } from './admin/admin.module';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BugReportsModule } from './bug-reports/bug-reports.module';
import { AllExceptionsFilter } from './common/filters';
import { JwtAuthGuard, RateLimitGuard, RolesGuard } from './common/guards';
import { LoggingInterceptor } from './common/interceptors';
import { configuration } from './config/configuration';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { ExportsSchedulerModule } from './exports/exports-scheduler.module';
import { HealthModule } from './health/health.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { InvitesModule } from './invites/invites.module';
import { MonitoringSchedulerModule } from './monitoring/monitoring-scheduler.module';
import { RedisModule } from './redis/redis.module';
import { RulesSchedulerModule } from './rules/rules-scheduler.module';
import { SkillsModule } from './skills/skills.module';
import { SlackModule } from './slack/slack.module';
import { SpacesModule } from './spaces/spaces.module';
import { SuperAdminModule } from './super-admin/super-admin.module';
import { TaskRunnerModule } from './tasks/task-runner.module';
import { UsageModule } from './usage/usage.module';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    InvitesModule,
    IntegrationsModule,
    SkillsModule,
    SpacesModule,
    TaskRunnerModule,
    AiModule,
    SlackModule,
    RulesSchedulerModule,
    MonitoringSchedulerModule,
    ExportsSchedulerModule,
    UsageModule,
    BillingModule,
    AdminModule,
    SuperAdminModule,
    BugReportsModule,
    HealthModule,
  ],
  providers: [
    // Global authentication: every route requires a valid JWT unless @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Global authorization: enforces @Roles() where present.
    { provide: APP_GUARD, useClass: RolesGuard },
    // Enforces @RateLimit() where present; no-op on routes without it.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Consistent error shape across the app.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Per-request logging.
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
