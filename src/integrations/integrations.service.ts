import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { App, CreateTokenResponse } from '@pipedream/sdk';
import Redis from 'ioredis';
import { Brackets, Repository } from 'typeorm';
import { REDIS_CLIENT } from '../common/constants';
import { META_ADS_TOOLS } from '../ai/meta-ads-tools';
import { Integration, IntegrationAccessLevel, IntegrationProvider } from '../database/entities';
import { ConfirmConnectionDto } from './dto';
import { MetaMcpServer, MetaMcpService } from './meta-mcp.service';
import { AppTool, PipedreamService } from './pipedream.service';
import type { SheetsCredential } from './sheets.service';

/** How long a pending Meta OAuth handshake (PKCE verifier + scope) lives. */
const META_STATE_TTL_SECONDS = 600;
/** Redis key prefix for pending Meta OAuth handshakes, keyed by `state`. */
const META_STATE_PREFIX = 'meta:oauth:';

/** Redis key prefix for a cached app action list, keyed by app slug. */
const TOOLS_CACHE_PREFIX = 'pd:tools:';
/**
 * How long a cached action list is served without revalidating. An app's actions
 * change on Pipedream's release cadence, not ours, so a day is generous.
 */
const TOOLS_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
/**
 * How long the entry physically survives — deliberately far longer than it stays
 * fresh, because an expired-but-present list is what a Pipedream outage falls
 * back to.
 */
const TOOLS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The pending-connect context stashed in Redis between authorize and callback. */
interface MetaOAuthState {
  workspaceId: string;
  userId: string;
  accessLevel: IntegrationAccessLevel;
  codeVerifier: string;
}

/** A Meta MCP server descriptor paired with its per-connection access token. */
export interface MetaMcpServerWithToken extends MetaMcpServer {
  authorizationToken: string;
}

/** A connected account, enriched with the member who connected it. */
export interface ConnectedIntegrationView {
  id: string;
  provider: IntegrationProvider;
  appName: string;
  appSlug: string;
  accountName: string | null;
  nickname: string | null;
  accessLevel: IntegrationAccessLevel;
  iconUrl: string | null;
  externalAccountId: string | null;
  isActive: boolean;
  connectedAt: Date;
  userId: string;
  userName: string | null;
}

/**
 * Manages external app connections backed by Pipedream Connect. `team` accounts
 * are scoped to the workspace `external_user_id` (shared by every member);
 * `private` accounts live under the connecting member's own namespace, so only
 * they can see and use them.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    private readonly pipedream: PipedreamService,
    private readonly metaMcp: MetaMcpService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * The Pipedream `external_user_id` an account of a given access level lives
   * under: the workspace id for `team`, the member's own namespace for
   * `private`.
   */
  private resolveExternalUserId(
    workspaceId: string,
    userId: string,
    accessLevel: IntegrationAccessLevel,
  ): string {
    return accessLevel === 'private' ? PipedreamService.privateExternalUserId(userId) : workspaceId;
  }

  /**
   * List the accounts a member may see: every `team` account in the workspace
   * plus their own `private` accounts. A null `userId` is a userless run (a
   * system task, a monitoring sweep) and sees team accounts only.
   */
  async findVisibleForUser(
    workspaceId: string,
    userId: string | null,
  ): Promise<ConnectedIntegrationView[]> {
    const rows = await this.integrationRepository
      .createQueryBuilder('integration')
      .leftJoinAndSelect('integration.user', 'user')
      .where('integration.workspaceId = :workspaceId', { workspaceId })
      .andWhere(
        new Brackets((qb) => {
          qb.where('integration.accessLevel = :team', { team: 'team' });
          if (userId) qb.orWhere('integration.userId = :userId', { userId });
        }),
      )
      .orderBy('integration.connectedAt', 'DESC')
      .getMany();
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      appName: row.appName,
      appSlug: row.appSlug,
      accountName: row.accountName,
      nickname: row.nickname,
      accessLevel: row.accessLevel,
      iconUrl: row.iconUrl,
      externalAccountId: row.externalAccountId,
      isActive: row.isActive,
      connectedAt: row.connectedAt,
      userId: row.userId,
      userName: row.user?.name ?? null,
    }));
  }

  /**
   * Every connected account in a workspace, paired with the member who connected
   * it, for a full workspace report ("who has connected what?"). Inactive
   * accounts are included so health/connection issues can be surfaced. Returns
   * only what's safe to show — account labels, never tokens or external ids.
   */
  async getWorkspaceIntegrations(workspaceId: string): Promise<
    Array<{
      userName: string | null;
      appName: string;
      appSlug: string;
      label: string | null;
      isActive: boolean;
      accessLevel: IntegrationAccessLevel;
    }>
  > {
    const rows = await this.integrationRepository
      .createQueryBuilder('integration')
      .leftJoinAndSelect('integration.user', 'user')
      .where('integration.workspaceId = :workspaceId', { workspaceId })
      .orderBy('user.name', 'ASC')
      .addOrderBy('integration.appName', 'ASC')
      .getMany();
    return rows.map((row) => ({
      userName: row.user?.name ?? null,
      appName: row.appName,
      appSlug: row.appSlug,
      // The member-set nickname best matches the "label" column users expect;
      // fall back to the Pipedream account name.
      label: row.nickname ?? row.accountName ?? null,
      isActive: row.isActive,
      accessLevel: row.accessLevel,
    }));
  }

  /**
   * Mint a single-use Pipedream Connect token under the scope the chosen access
   * level resolves to, so the account connects into the right bucket.
   */
  getConnectToken(
    workspaceId: string,
    userId: string,
    accessLevel: IntegrationAccessLevel = 'team',
  ): Promise<CreateTokenResponse> {
    return this.pipedream.createConnectToken(
      this.resolveExternalUserId(workspaceId, userId, accessLevel),
    );
  }

  /** Search the Pipedream app catalogue for the connect UI. */
  listApps(query?: string, after?: string): Promise<{ apps: App[]; after?: string }> {
    return this.pipedream.listApps(query, after);
  }

  /**
   * Every action a given app exposes, for the "what can it do?" UI.
   *
   * An app's action list is a property of Pipedream's catalogue, not of this
   * workspace, so it is cached once globally rather than refetched on each visit
   * — the panel was previously costing a live Pipedream round trip every time
   * anyone opened an integration. A stale entry is kept well past the point it
   * goes cold and served when Pipedream is unreachable, so an outage degrades to
   * a slightly dated list instead of an error where the capabilities should be.
   */
  async listAppTools(appSlug: string): Promise<{ tools: AppTool[] }> {
    // Meta Ads is served by our own native tools (not Pipedream), so its
    // capability list comes from the local tool definitions, not the catalogue.
    if (appSlug === 'meta_ads') {
      return { tools: this.metaAdsTools() };
    }

    const cached = await this.readCachedTools(appSlug);
    if (cached && Date.now() - cached.fetchedAt < TOOLS_CACHE_FRESH_MS) {
      return { tools: cached.tools };
    }

    try {
      const { tools } = await this.pipedream.listAppTools(appSlug);
      await this.writeCachedTools(appSlug, tools);
      return { tools };
    } catch (error) {
      // Cold cache means there is nothing to fall back to — let the failure
      // surface. Otherwise the stale list is far better than an error card.
      if (!cached) throw error;
      this.logger.warn(
        `Serving stale tool list for ${appSlug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { tools: cached.tools };
    }
  }

  /** Read a cached action list, tolerating a missing or unparseable entry. */
  private async readCachedTools(
    appSlug: string,
  ): Promise<{ tools: AppTool[]; fetchedAt: number } | null> {
    try {
      const raw = await this.redis.get(`${TOOLS_CACHE_PREFIX}${appSlug}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { tools?: AppTool[]; fetchedAt?: number };
      if (!Array.isArray(parsed.tools) || typeof parsed.fetchedAt !== 'number') return null;
      return { tools: parsed.tools, fetchedAt: parsed.fetchedAt };
    } catch (error) {
      this.logger.warn(
        `Failed to read cached tools for ${appSlug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /** Cache an action list. Best-effort: a cache write must never fail the request. */
  private async writeCachedTools(appSlug: string, tools: AppTool[]): Promise<void> {
    try {
      await this.redis.set(
        `${TOOLS_CACHE_PREFIX}${appSlug}`,
        JSON.stringify({ tools, fetchedAt: Date.now() }),
        'EX',
        TOOLS_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to cache tools for ${appSlug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The native Meta Ads tools mapped to the UI's AppTool shape. */
  private metaAdsTools(): AppTool[] {
    return META_ADS_TOOLS.filter(
      (tool): tool is Extract<typeof tool, { name: string }> => 'name' in tool,
    ).map((tool) => ({
      key: tool.name,
      // "meta_ads_list_ad_accounts" -> "List ad accounts"
      name: this.humanizeToolName(tool.name),
      description: 'description' in tool ? tool.description : undefined,
    }));
  }

  /** Turn a snake_case Meta tool name into a readable, sentence-case label. */
  private humanizeToolName(name: string): string {
    const words = name
      .replace(/^meta_ads_/, '')
      .replace(/_/g, ' ')
      .trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  /**
   * Persist a connection after the frontend's Pipedream popup succeeds. Fetches
   * the account from Pipedream to confirm it belongs to the workspace, then
   * upserts the row (idempotent on the (workspaceId, externalAccountId) index).
   */
  async confirmConnection(
    workspaceId: string,
    userId: string,
    { accountId, appSlug, accessLevel, nickname }: ConfirmConnectionDto,
  ): Promise<Integration> {
    // Look the account up under the same scope it was connected with, so a
    // member can't claim an account that isn't theirs to confirm.
    const externalUserId = this.resolveExternalUserId(workspaceId, userId, accessLevel);
    const account = await this.pipedream.getAccount(accountId, externalUserId);
    if (!account) {
      throw new NotFoundException('Connected account not found for this scope');
    }

    const existing = await this.integrationRepository.findOne({
      where: { workspaceId, externalAccountId: account.id },
    });

    const integration =
      existing ??
      this.integrationRepository.create({
        workspaceId,
        userId,
        externalAccountId: account.id,
      });

    integration.userId = existing?.userId ?? userId;
    integration.appSlug = account.app?.nameSlug ?? appSlug;
    integration.appName = account.app?.name ?? appSlug;
    integration.accountName = account.name ?? null;
    integration.nickname = nickname?.trim() || null;
    integration.accessLevel = accessLevel;
    integration.iconUrl = account.app?.imgSrc ?? null;
    integration.isActive = account.healthy !== false;

    return this.integrationRepository.save(integration);
  }

  /**
   * Apply a partial update from the configure screen (label, access level, or
   * enabled state) and return the refreshed view. Scoped to the workspace so a
   * member can't edit another tenant's account.
   *
   * Note: for Pipedream accounts, `accessLevel` here only changes visibility in
   * our queries — the account still lives under the Pipedream scope it was
   * connected with, so moving team↔private may require a reconnect for AI runs
   * to route to it. Meta accounts carry their own token, so the change is exact.
   */
  async update(
    workspaceId: string,
    integrationId: string,
    patch: { nickname?: string; accessLevel?: IntegrationAccessLevel; isActive?: boolean },
  ): Promise<ConnectedIntegrationView> {
    const integration = await this.integrationRepository.findOne({
      where: { id: integrationId, workspaceId },
      relations: { user: true },
    });
    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    if (patch.nickname !== undefined) integration.nickname = patch.nickname.trim() || null;
    if (patch.accessLevel !== undefined) integration.accessLevel = patch.accessLevel;
    if (patch.isActive !== undefined) integration.isActive = patch.isActive;

    const saved = await this.integrationRepository.save(integration);
    return {
      id: saved.id,
      provider: saved.provider,
      appName: saved.appName,
      appSlug: saved.appSlug,
      accountName: saved.accountName,
      nickname: saved.nickname,
      accessLevel: saved.accessLevel,
      iconUrl: saved.iconUrl,
      externalAccountId: saved.externalAccountId,
      isActive: saved.isActive,
      connectedAt: saved.connectedAt,
      userId: saved.userId,
      userName: integration.user?.name ?? null,
    };
  }

  /**
   * Disconnect an integration and remove the row. Pipedream connections are
   * also revoked at Pipedream; `meta` connections just drop the stored token
   * (there's no Pipedream account to revoke). Scoped to the workspace so members
   * can't disconnect other tenants.
   */
  async disconnect(workspaceId: string, integrationId: string): Promise<{ success: boolean }> {
    const integration = await this.integrationRepository.findOne({
      where: { id: integrationId, workspaceId },
    });
    if (!integration) {
      throw new NotFoundException('Integration not found');
    }

    if (integration.provider === 'pipedream' && integration.externalAccountId) {
      try {
        await this.pipedream.deleteAccount(integration.externalAccountId);
      } catch (error) {
        // The account may already be gone at Pipedream; log and continue so the
        // local row is still removed.
        this.logger.warn(
          `Failed to revoke Pipedream account ${integration.externalAccountId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.integrationRepository.remove(integration);
    return { success: true };
  }

  // ── Meta Ads (native, non-Pipedream) ──────────────────────────────────────

  /**
   * Begin a Meta Ads connect: generate PKCE + `state`, stash the pending
   * handshake (who's connecting, at what access level, the PKCE verifier) in
   * Redis under `state`, and return the Meta consent URL for the browser. The
   * state carries identity through the OAuth round-trip, so the callback can be
   * public (Meta's redirect won't carry our JWT).
   */
  async startMetaConnect(
    workspaceId: string,
    userId: string,
    accessLevel: IntegrationAccessLevel = 'team',
  ): Promise<{ url: string }> {
    const { verifier, challenge } = MetaMcpService.generatePkce();
    const state = MetaMcpService.generateState();
    const payload: MetaOAuthState = { workspaceId, userId, accessLevel, codeVerifier: verifier };
    await this.redis.set(
      `${META_STATE_PREFIX}${state}`,
      JSON.stringify(payload),
      'EX',
      META_STATE_TTL_SECONDS,
    );
    const url = await this.metaMcp.buildAuthorizationUrl(state, challenge);
    return { url };
  }

  /**
   * Complete a Meta Ads connect: validate and consume the pending `state`,
   * exchange the code for tokens, and upsert the integration row (idempotent on
   * the (workspaceId, externalAccountId) index, so re-connecting refreshes it).
   */
  async completeMetaConnect(state: string, code: string): Promise<Integration> {
    const key = `${META_STATE_PREFIX}${state}`;
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new NotFoundException('Meta connect session expired or invalid');
    }
    await this.redis.del(key);
    const { workspaceId, userId, accessLevel, codeVerifier } = JSON.parse(raw) as MetaOAuthState;

    const connection = await this.metaMcp.exchangeCode(code, codeVerifier);

    const existing = await this.integrationRepository.findOne({
      where: { workspaceId, externalAccountId: connection.accountId },
    });
    const integration =
      existing ??
      this.integrationRepository.create({
        workspaceId,
        userId,
        externalAccountId: connection.accountId,
      });

    integration.userId = existing?.userId ?? userId;
    integration.provider = 'meta';
    integration.appSlug = connection.appSlug;
    integration.appName = connection.appName;
    integration.accountName = connection.accountName;
    integration.accessLevel = accessLevel;
    integration.iconUrl = connection.iconUrl;
    integration.isActive = true;
    integration.accessToken = connection.accessToken;
    integration.refreshToken = connection.refreshToken;
    integration.tokenExpiresAt = connection.expiresAt;
    integration.scopes = connection.scopes;

    return this.integrationRepository.save(integration);
  }

  /**
   * Build the Meta MCP servers a member may use — every team Meta account plus
   * their own private ones — each paired with a valid access token (refreshed
   * and persisted here when stale). Used by the AI run to expose Meta as an MCP
   * toolset alongside the Pipedream servers.
   */
  async buildMetaMcpServers(
    workspaceId: string,
    userId: string,
  ): Promise<MetaMcpServerWithToken[]> {
    const rows = await this.visibleMetaIntegrations(workspaceId, userId);
    const servers: MetaMcpServerWithToken[] = [];
    for (const row of rows) {
      const token = await this.ensureFreshMetaToken(row);
      if (!token) continue;
      servers.push({ ...this.metaMcp.buildMcpServer(row.id), authorizationToken: token });
    }
    return servers;
  }

  /**
   * The Meta accounts a member may use: every team Meta account plus their own
   * private ones, active only. Shared by the MCP-server build and the native
   * Meta Ads token resolver.
   */
  private visibleMetaIntegrations(
    workspaceId: string,
    userId: string | null,
  ): Promise<Integration[]> {
    return this.integrationRepository
      .createQueryBuilder('integration')
      .where('integration.workspaceId = :workspaceId', { workspaceId })
      .andWhere('integration.provider = :provider', { provider: 'meta' })
      .andWhere('integration.isActive = true')
      .andWhere(
        new Brackets((qb) => {
          qb.where('integration.accessLevel = :team', { team: 'team' });
          if (userId) qb.orWhere('integration.userId = :userId', { userId });
        }),
      )
      .getMany();
  }

  /**
   * Resolve the Stripe secret API key of the member's visible Stripe connection
   * (team accounts preferred over private), by pulling the stored credentials
   * from Pipedream. Used by ROAS verification to read revenue directly — a
   * deterministic server-side computation rather than MCP round-trips. Returns
   * null when no usable Stripe account is connected.
   */
  async getStripeApiKey(workspaceId: string, userId: string | null): Promise<string | null> {
    // Stripe connects with a secret key; cover the field spellings Pipedream uses
    // for key-auth apps, plus OAuth token material as a fallback.
    return this.resolveAppCredential(workspaceId, userId, 'stripe', (credentials) =>
      this.firstString(credentials.api_key, credentials.apiKey, credentials.oauthAccessToken),
    );
  }

  /**
   * The member's Google Sheets connection, addressed the way the Connect proxy
   * wants it: an external user id plus an account id. Pipedream authenticates
   * the call from those, so no Google token is read or held here.
   *
   * Returns null when no Google Sheets account is connected.
   */
  getGoogleSheetsCredential(
    workspaceId: string,
    userId: string | null,
  ): Promise<SheetsCredential | null> {
    return this.getProxyCredential(workspaceId, userId, 'google_sheets');
  }

  /**
   * The member's connection to a Pipedream app, addressed for the Connect proxy
   * (external user id plus account id), team accounts first. Null when the app
   * is not connected.
   */
  async getProxyCredential(
    workspaceId: string,
    userId: string | null,
    appSlug: string,
  ): Promise<{ externalUserId: string; accountId: string } | null> {
    const connections = await this.visibleAppConnections(workspaceId, userId, appSlug);
    const connection = connections.find((row) => row.externalAccountId);
    if (!connection) return null;
    return {
      externalUserId: this.resolveExternalUserId(
        workspaceId,
        connection.userId,
        connection.accessLevel,
      ),
      accountId: connection.externalAccountId!,
    };
  }

  /**
   * The member's active connections for one Pipedream app, team accounts first —
   * the shared connection is the workspace's source of truth.
   */
  private async visibleAppConnections(
    workspaceId: string,
    userId: string | null,
    appSlug: string,
  ): Promise<ConnectedIntegrationView[]> {
    const visible = (await this.findVisibleForUser(workspaceId, userId)).filter(
      (row) => row.isActive && row.provider === 'pipedream' && row.appSlug === appSlug,
    );
    visible.sort((a, b) =>
      a.accessLevel === b.accessLevel ? 0 : a.accessLevel === 'team' ? -1 : 1,
    );
    return visible;
  }

  /**
   * Pull a credential out of the workspace's connected account for one Pipedream
   * app, so an app's API can be called directly (deterministic, server-side)
   * instead of through MCP round-trips. Team accounts are tried before private
   * ones — the shared connection is the workspace's source of truth — and an
   * account whose credentials can't be read is skipped rather than fatal, so one
   * broken connection doesn't mask a working one.
   */
  private async resolveAppCredential(
    workspaceId: string,
    userId: string | null,
    appSlug: string,
    pick: (credentials: Record<string, unknown>) => string | null,
  ): Promise<string | null> {
    const visible = (await this.visibleAppConnections(workspaceId, userId, appSlug)).filter(
      (row) => row.externalAccountId,
    );

    for (const row of visible) {
      try {
        const credentials = await this.pipedream.getAccountCredentials(row.externalAccountId!);
        const value = credentials ? pick(credentials) : null;
        if (value) return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Failed to read ${appSlug} credentials for ${row.id}: ${message}`);
      }
    }
    return null;
  }

  /** The first candidate that is a non-empty string, else null. */
  private firstString(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate) return candidate;
    }
    return null;
  }

  /**
   * Every workspace that has at least one active Meta connection — the sweep
   * list for proactive monitoring (anomaly alerts), which runs without a user.
   */
  async listActiveMetaWorkspaceIds(): Promise<string[]> {
    const rows = await this.integrationRepository
      .createQueryBuilder('integration')
      .select('DISTINCT integration.workspaceId', 'workspaceId')
      .where('integration.provider = :provider', { provider: 'meta' })
      .andWhere('integration.isActive = true')
      .getRawMany<{ workspaceId: string }>();
    return rows.map((row) => row.workspaceId);
  }

  /**
   * Resolve a valid Meta access token for the member's run — the freshest token
   * of the first visible active Meta account. Used by the native Meta Ads tools,
   * which call the Marketing API directly (Meta's hosted MCP is allowlist-gated
   * and rejects our token). Returns null when there's no usable Meta connection.
   */
  async getMetaAccessToken(workspaceId: string, userId: string | null): Promise<string | null> {
    const rows = await this.visibleMetaIntegrations(workspaceId, userId);
    for (const row of rows) {
      const token = await this.ensureFreshMetaToken(row);
      if (token) return token;
    }
    return null;
  }

  /**
   * Return a valid access token for a Meta connection, refreshing and persisting
   * it when expired. Returns null (and deactivates the row) if the connection
   * can no longer be refreshed, so a dead account drops out of AI runs.
   */
  private async ensureFreshMetaToken(integration: Integration): Promise<string | null> {
    if (integration.accessToken && !this.metaMcp.isExpired(integration.tokenExpiresAt)) {
      return integration.accessToken;
    }
    if (!integration.refreshToken) return integration.accessToken;

    try {
      const refreshed = await this.metaMcp.refreshAccessToken(integration.refreshToken);
      integration.accessToken = refreshed.accessToken;
      integration.refreshToken = refreshed.refreshToken ?? integration.refreshToken;
      integration.tokenExpiresAt = refreshed.expiresAt;
      if (refreshed.scopes) integration.scopes = refreshed.scopes;
      await this.integrationRepository.save(integration);
      return integration.accessToken;
    } catch (error) {
      this.logger.warn(
        `Failed to refresh Meta token for integration ${integration.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      integration.isActive = false;
      await this.integrationRepository.save(integration);
      return null;
    }
  }
}
