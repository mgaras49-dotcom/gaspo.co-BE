import {
  HttpException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Account,
  App,
  CreateTokenResponse,
  PipedreamClient,
  PipedreamError,
  ProjectEnvironment,
} from '@pipedream/sdk';
import { AppConfig } from '../config/configuration';

/** Fail fast rather than letting a dead connection hang on SDK retries. */
const REQUEST_OPTIONS = { timeoutInSeconds: 20 };

/** Pipedream's managed remote MCP server — one logical server per connected app. */
const PIPEDREAM_MCP_BASE_URL = 'https://remote.mcp.pipedream.net/v3';

/** Actions requested per page when enumerating an app's tools. */
const TOOL_PAGE_SIZE = 100;

/**
 * Ceiling on pages walked for one app's action list, so a runaway cursor cannot
 * spin. At {@link TOOL_PAGE_SIZE} per page this covers far more actions than any
 * real app exposes.
 */
const MAX_TOOL_PAGES = 20;

/**
 * Pull the actionable message out of a failed Connect proxy call.
 *
 * The SDK's own `message` is a `"Status code: N\nBody: {…}"` blob, which is what
 * would otherwise reach a Slack failure notice. Two body shapes turn up in
 * practice: the target API's envelope (`{error: {message}}` — Google and Stripe
 * both use it) and Pipedream's own rejection (`{error: "…"}`, e.g. when a domain
 * is not on the app's allowlist). Returns null when neither is present, so the
 * caller can keep the original error.
 */
export function proxyErrorMessage(error: unknown): string | null {
  const body = (error as { body?: unknown })?.body;
  if (!body || typeof body !== 'object') return null;
  const inner = (body as { error?: unknown }).error;
  if (typeof inner === 'string') return inner;
  if (inner && typeof inner === 'object') {
    const message = (inner as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

/** A connected app exposed to an LLM as a Pipedream MCP server. */
export interface PipedreamMcpServer {
  appSlug: string;
  name: string;
  url: string;
  /** The account's label, when the server is pinned to one of several accounts. */
  accountLabel?: string;
  /** The app router's id for it; see {@link RemoteMcpServer.routeId}. */
  routeId?: string;
}

/** One of several accounts of an app, to be served as its own MCP server. */
export interface PipedreamAccountTarget {
  appSlug: string;
  accountId: string;
  label: string;
}

/**
 * A short, name-safe tag for an account label: "Alnyra (alnyra-com.myshopify.com)"
 * becomes "alnyra". It goes into the server name, which prefixes every tool the
 * model sees, so the model can tell one store's tools from another's.
 */
export function accountTag(label: string): string {
  const tag = label
    .toLowerCase()
    .replace(/\(.*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
  return tag || 'account';
}

/** A single action an app exposes — surfaced as an MCP tool to the LLM. */
export interface AppTool {
  key: string;
  name: string;
  description?: string;
}

/**
 * Thin wrapper over the Pipedream Connect SDK. Owns the single backend client
 * and exposes the few operations the integrations module needs: minting
 * connect tokens, reading/removing a workspace's connected accounts, and
 * proxying the app catalogue.
 *
 * The `external_user_id` we pass to Pipedream is the gaspo workspace id for
 * `team` accounts (shared by every member) and a per-user namespace for
 * `private` accounts (see {@link PipedreamService.privateExternalUserId}), so
 * access isolation holds at the Pipedream boundary, not just in our queries.
 *
 * The client is built lazily: when credentials are absent the app still boots
 * (mirroring the Slack module), and only the integration endpoints fail.
 */
@Injectable()
export class PipedreamService implements OnModuleInit {
  private readonly logger = new Logger(PipedreamService.name);
  private client: PipedreamClient | null = null;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  /**
   * The Pipedream `external_user_id` a member's `private` accounts live under.
   * Namespaced so it can never collide with a workspace id, giving private
   * accounts their own isolated bucket at Pipedream.
   */
  static privateExternalUserId(userId: string): string {
    return `u:${userId}`;
  }

  onModuleInit(): void {
    const pd = this.configService.get('pipedream', { infer: true });
    if (!pd.clientId || !pd.clientSecret || !pd.projectId) {
      this.logger.warn(
        'Pipedream credentials are not fully configured; integration connect flows will fail until PIPEDREAM_* env vars are set.',
      );
      return;
    }
    this.client = new PipedreamClient({
      clientId: pd.clientId,
      clientSecret: pd.clientSecret,
      projectId: pd.projectId,
      projectEnvironment: pd.environment as ProjectEnvironment,
    });
  }

  private getClient(): PipedreamClient {
    if (!this.client) {
      throw new ServiceUnavailableException('Pipedream integration is not configured');
    }
    return this.client;
  }

  /**
   * Run an SDK call, translating failures into clear HTTP errors. A Pipedream
   * error without a `statusCode` is a transport failure (DNS, timeout, dropped
   * connection) — surface it as 503 so the client can retry rather than
   * swallowing an opaque 500.
   */
  private async run<T>(label: string, fn: (client: PipedreamClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.getClient());
    } catch (error) {
      if (error instanceof HttpException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const cause =
        error instanceof PipedreamError
          ? ((error.cause as { code?: string })?.code ?? error.statusCode)
          : undefined;
      this.logger.error(`Pipedream ${label} failed: ${message}${cause ? ` (${cause})` : ''}`);
      if (error instanceof PipedreamError && !error.statusCode) {
        throw new ServiceUnavailableException('Pipedream is currently unreachable, please retry');
      }
      throw new ServiceUnavailableException(`Pipedream request failed: ${message}`);
    }
  }

  /** Mint a single-use Connect token scoped to an external user. */
  createConnectToken(externalUserId: string): Promise<CreateTokenResponse> {
    return this.run('tokens.create', (client) =>
      client.tokens.create({ externalUserId }, REQUEST_OPTIONS),
    );
  }

  /** List every connected account belonging to an external user. */
  listAccounts(externalUserId: string): Promise<Account[]> {
    return this.run('accounts.list', async (client) => {
      const accounts: Account[] = [];
      const page = await client.accounts.list({ externalUserId }, REQUEST_OPTIONS);
      for await (const account of page) {
        accounts.push(account);
      }
      return accounts;
    });
  }

  /**
   * Fetch a single account, scoped to the external user that should own it. We
   * look it up within that external user's account list (rather than `retrieve`,
   * which can't filter by external user) so a caller can only confirm accounts
   * that actually belong to the scope it claims. Returns null if none exists.
   */
  async getAccount(accountId: string, externalUserId: string): Promise<Account | null> {
    const accounts = await this.listAccounts(externalUserId);
    return accounts.find((account) => account.id === accountId) ?? null;
  }

  /**
   * Fetch an account's stored credentials (API key / OAuth token material).
   * Used to call an app's API directly when the model needs deterministic,
   * server-side computation (e.g. Stripe revenue for ROAS verification) rather
   * than MCP tool round-trips. Handle the result carefully — never log or
   * surface it.
   */
  getAccountCredentials(accountId: string): Promise<Record<string, unknown> | null> {
    return this.run('accounts.retrieve', async (client) => {
      const account = await client.accounts.retrieve(
        accountId,
        { includeCredentials: true },
        REQUEST_OPTIONS,
      );
      return (account.credentials as Record<string, unknown> | undefined) ?? null;
    });
  }

  /**
   * Forward an authenticated request to a connected app's own API through the
   * Pipedream Connect proxy. Pipedream attaches the account's credentials and
   * refreshes them when needed, so the caller never handles a token — the
   * preferred way to make a deterministic, server-side API call against a
   * connected app.
   *
   * Errors are surfaced as-is rather than translated to HTTP exceptions: these
   * calls sit behind tools and schedulers that report failures in their own
   * shape, not behind a controller.
   */
  async proxyRequest<T>(
    target: { externalUserId: string; accountId: string },
    request: {
      url: string;
      method?: 'GET' | 'POST';
      body?: Record<string, unknown>;
      /** Query parameters for the target API. */
      params?: Record<string, string>;
      /** Headers for the target API (Pipedream forwards them unprefixed). */
      headers?: Record<string, string>;
    },
  ): Promise<T> {
    const client = this.getClient();
    const common = {
      url: request.url,
      externalUserId: target.externalUserId,
      accountId: target.accountId,
      ...(request.params ? { params: request.params } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
    };
    try {
      const response =
        request.method === 'POST'
          ? await client.proxy.post({ ...common, body: request.body ?? {} }, REQUEST_OPTIONS)
          : await client.proxy.get(common, REQUEST_OPTIONS);
      return response as T;
    } catch (error) {
      // A non-2xx from the target app throws, carrying the target's own error
      // body. Raise that message rather than the SDK's "Status code: N / Body:
      // {…}" blob, which is what would otherwise reach a Slack failure notice.
      const detail = proxyErrorMessage(error);
      throw detail ? new Error(detail) : error;
    }
  }

  /** Revoke a connected account at Pipedream. */
  async deleteAccount(accountId: string): Promise<void> {
    await this.run('accounts.delete', (client) =>
      client.accounts.delete(accountId, REQUEST_OPTIONS),
    );
  }

  /**
   * Search the Pipedream app catalogue. Returns one page of apps plus the
   * cursor for the following page (undefined when there are no more results).
   */
  listApps(query?: string, after?: string): Promise<{ apps: App[]; after?: string }> {
    return this.run('apps.list', async (client) => {
      const page = await client.apps.list(
        {
          q: query || undefined,
          after: after || undefined,
          limit: 48,
          sortKey: 'featured_weight',
          sortDirection: 'desc',
        },
        REQUEST_OPTIONS,
      );
      return {
        apps: page.data,
        after: page.hasNextPage() ? page.response.pageInfo?.endCursor : undefined,
      };
    });
  }

  /**
   * Every action an app exposes. These are the same components Pipedream's
   * remote MCP server turns into tools, so this answers "what can Gaspo do with
   * this app?" for the UI.
   *
   * Pages are followed here rather than by the caller: the UI wants the whole
   * list at once, and the result is cached upstream, so paginating outward would
   * multiply the round trips this exists to avoid. {@link MAX_TOOL_PAGES} bounds
   * a pathological app rather than looping on a runaway cursor.
   */
  listAppTools(appSlug: string): Promise<{ tools: AppTool[] }> {
    return this.run('actions.list', async (client) => {
      const tools: AppTool[] = [];
      let after: string | undefined;

      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await client.actions.list(
          { app: appSlug, after: after || undefined, limit: TOOL_PAGE_SIZE },
          REQUEST_OPTIONS,
        );
        tools.push(
          ...result.data.map((action) => ({
            key: action.key,
            name: action.name,
            description: action.description ?? undefined,
          })),
        );
        if (!result.hasNextPage()) break;
        after = result.response.pageInfo?.endCursor;
        // A next-page flag with no cursor would otherwise refetch page one forever.
        if (!after) break;
      }

      return { tools };
    });
  }

  /**
   * A short-lived Pipedream API access token. Used as the bearer credential when
   * an LLM connects to Pipedream's remote MCP server on a workspace's behalf.
   */
  getAccessToken(): Promise<string> {
    return this.run('rawAccessToken', (client) => client.rawAccessToken);
  }

  /**
   * Build the Pipedream MCP server descriptors for an external user's connected
   * apps. Pipedream accepts its routing parameters as query string values (only
   * the bearer token must be a header), so each app maps to one MCP URL the LLM
   * can point at directly. The caller pairs these with {@link getAccessToken}.
   *
   * The server name is keyed by both the app and the external user so the same
   * app connected under two scopes (e.g. a team and a private account) produces
   * two distinct, non-colliding servers.
   */
  /**
   * Like {@link buildMcpServers}, but one server per account, each pinned with
   * Pipedream's `accountId` parameter. Used when a scope holds several accounts
   * of one app: unpinned, Pipedream picks an account by itself, and on 30 Sept
   * 2026 a revenue question meant for 33 stores ran against whichever one that
   * happened to be.
   */
  buildAccountMcpServers(
    externalUserId: string,
    accounts: PipedreamAccountTarget[],
  ): PipedreamMcpServer[] {
    const pd = this.configService.get('pipedream', { infer: true });
    const scope = externalUserId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const used = new Set<string>();
    return accounts.map(({ appSlug, accountId, label }) => {
      // Two stores can share a tag ("store", "store"); the account id's tail
      // keeps the server names apart.
      let tag = accountTag(label);
      if (used.has(`${appSlug}-${tag}`)) tag = `${tag}-${accountId.slice(-4).toLowerCase()}`;
      used.add(`${appSlug}-${tag}`);
      const params = new URLSearchParams({
        projectId: pd.projectId,
        environment: pd.environment,
        externalUserId,
        app: appSlug,
        accountId,
      });
      return {
        appSlug,
        name: `pipedream-${scope}-${appSlug}-${tag}`,
        url: `${PIPEDREAM_MCP_BASE_URL}?${params.toString()}`,
        accountLabel: label,
        routeId: `${appSlug}:${tag}`,
      };
    });
  }

  buildMcpServers(externalUserId: string, appSlugs: string[]): PipedreamMcpServer[] {
    const pd = this.configService.get('pipedream', { infer: true });
    const scope = externalUserId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return appSlugs.map((appSlug) => {
      const params = new URLSearchParams({
        projectId: pd.projectId,
        environment: pd.environment,
        externalUserId,
        app: appSlug,
      });
      return {
        appSlug,
        name: `pipedream-${scope}-${appSlug}`,
        url: `${PIPEDREAM_MCP_BASE_URL}?${params.toString()}`,
      };
    });
  }
}
