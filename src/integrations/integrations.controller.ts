import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { App, CreateTokenResponse } from '@pipedream/sdk';
import { Response } from 'express';
import { CurrentUser, Public } from '../common/decorators';
import { AppConfig } from '../config/configuration';
import { Integration } from '../database/entities';
import {
  ConfirmConnectionDto,
  ConnectTokenDto,
  MetaAuthorizeDto,
  MetaCallbackDto,
  UpdateIntegrationDto,
} from './dto';
import { ConnectedIntegrationView, IntegrationsService } from './integrations.service';
import { MetaPermissionsError } from './meta-mcp.service';
import { AppTool } from './pipedream.service';

/**
 * The one-word reason the dashboard gets after a failed Meta connect. Two
 * failures the person can act on themselves are named: they backed out of the
 * dialog, or Meta issued a token without the ad permissions (re-tick them, or
 * get a role on the app). Everything else is a plain `meta`.
 */
function metaErrorCode(query: MetaCallbackDto, error: unknown): string {
  if (query.error_reason === 'user_denied' || query.action === 'cancel') return 'meta_cancelled';
  if (error instanceof MetaPermissionsError) return 'meta_permissions';
  return 'meta';
}

@ApiTags('integrations')
@Controller('integrations')
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  /** List the integrations the current member may see (team + own private). */
  @Get()
  list(
    @CurrentUser('workspaceId') workspaceId: string,
    @CurrentUser('userId') userId: string,
  ): Promise<ConnectedIntegrationView[]> {
    return this.integrationsService.findVisibleForUser(workspaceId, userId);
  }

  /** Search the Pipedream app catalogue for the connect UI. */
  @Get('apps')
  listApps(
    @Query('query') query?: string,
    @Query('after') after?: string,
  ): Promise<{ apps: App[]; after?: string }> {
    return this.integrationsService.listApps(query, after);
  }

  /**
   * Every action an app exposes, so the UI can show its capabilities. Returns the
   * complete list — the service pages through Pipedream and caches the result, so
   * there is no cursor for the client to follow.
   */
  @Get(':appSlug/tools')
  listAppTools(@Param('appSlug') appSlug: string): Promise<{ tools: AppTool[] }> {
    return this.integrationsService.listAppTools(appSlug);
  }

  /** Mint a single-use Pipedream Connect token for the current member's scope. */
  @Post('connect-token')
  connectToken(
    @CurrentUser('workspaceId') workspaceId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: ConnectTokenDto,
  ): Promise<CreateTokenResponse> {
    return this.integrationsService.getConnectToken(workspaceId, userId, dto.accessLevel);
  }

  /** Persist a connection after the Pipedream popup succeeds. */
  @Post('confirm')
  confirm(
    @CurrentUser('workspaceId') workspaceId: string,
    @CurrentUser('userId') userId: string,
    @Body() dto: ConfirmConnectionDto,
  ): Promise<Integration> {
    return this.integrationsService.confirmConnection(workspaceId, userId, dto);
  }

  /**
   * Start a native Meta Ads connect. Returns the Meta consent URL for the
   * frontend to open; the browser comes back to {@link metaCallback}.
   */
  @Get('meta/authorize')
  metaAuthorize(
    @CurrentUser('workspaceId') workspaceId: string,
    @CurrentUser('userId') userId: string,
    @Query() dto: MetaAuthorizeDto,
  ): Promise<{ url: string }> {
    return this.integrationsService.startMetaConnect(workspaceId, userId, dto.accessLevel);
  }

  /**
   * Meta redirects the browser here after consent. Public because Meta's
   * redirect carries no JWT — identity travels in the `state` we stashed. On
   * success we persist the connection and bounce back to the frontend.
   */
  @Public()
  @Get('meta/callback')
  async metaCallback(@Query() query: MetaCallbackDto, @Res() res: Response): Promise<void> {
    const frontendUrl = this.configService.get('app.frontendUrl', { infer: true });
    const redirect = new URL('/dashboard/integrations', frontendUrl);
    try {
      if (query.error || !query.code || !query.state) {
        throw new Error(
          query.error
            ? `${query.error}: ${query.error_description ?? ''} (${query.error_reason ?? ''})`
            : 'Missing code/state from Meta',
        );
      }
      await this.integrationsService.completeMetaConnect(query.state, query.code);
      redirect.searchParams.set('connected', 'meta');
    } catch (error) {
      // The browser only sees a one-word error, so this line is the one place
      // the real reason (expired state, token exchange rejected, ...) survives.
      this.logger.warn(
        `Meta connect failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      redirect.searchParams.set('error', metaErrorCode(query, error));
    }
    res.redirect(redirect.toString());
  }

  /** Update a connected account's label, access level, or enabled state. */
  @Patch(':id')
  update(
    @CurrentUser('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateIntegrationDto,
  ): Promise<ConnectedIntegrationView> {
    return this.integrationsService.update(workspaceId, id, dto);
  }

  /** Disconnect an integration and revoke it at Pipedream. */
  @Delete(':id')
  disconnect(
    @CurrentUser('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ): Promise<{ success: boolean }> {
    return this.integrationsService.disconnect(workspaceId, id);
  }
}
