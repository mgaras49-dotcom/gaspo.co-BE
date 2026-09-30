import { Module } from '@nestjs/common';
import { ExportsModule } from '../exports/exports.module';
import { FilesModule } from '../files/files.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { MemoryModule } from '../memory/memory.module';
import { RulesModule } from '../rules/rules.module';
import { SpacesModule } from '../spaces/spaces.module';
import { TasksModule } from '../tasks/tasks.module';
import { UsageModule } from '../usage/usage.module';
import { UsersModule } from '../users/users.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { AttachedAppsService } from './providers/attached-apps.service';
import { GatewayProvider } from './providers/gateway.provider';
import { McpBridgeService } from './providers/mcp-bridge.service';
import { ToolRouterService } from './providers/tool-router.service';

@Module({
  imports: [
    ExportsModule,
    FilesModule,
    IntegrationsModule,
    MemoryModule,
    RulesModule,
    SpacesModule,
    TasksModule,
    UsageModule,
    UsersModule,
    WorkspacesModule,
  ],
  controllers: [AiController],
  providers: [
    AiService,
    AnthropicProvider,
    AttachedAppsService,
    GatewayProvider,
    McpBridgeService,
    ToolRouterService,
  ],
  exports: [AiService],
})
export class AiModule {}
