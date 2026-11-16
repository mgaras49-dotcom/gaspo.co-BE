import { createHash, randomBytes } from 'crypto';
import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

/** The connected-app identity a `meta` integration is stored under. */
export const META_APP_SLUG = 'meta_ads';
export const META_APP_NAME = 'Meta Ads';
/** Meta's logo, cached on the row so the connected-apps UI matches other apps. */
const META_ICON_URL = 'https://www.facebook.com/images/fb_icon_325x325.png';
/** Refresh a token this many ms before it actually expires, to avoid races. */
const EXPIRY_SKEW_MS = 60_000;
/** Graph API root for the plain (non-MCP) calls: identity and token inspection. */
const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
/**
 * The one permission every Meta tool needs. Meta has issued `public_profile`-only
 * tokens when the app's access level or the user's role kept the ad permissions
 * out of the dialog; such a token looks connected and then fails every call with
 * "(#200) Missing Permissions", so a connect without this scope is refused.
 */
export const META_REQUIRED_SCOPE = 'ads_read';

/** Thrown when Meta issued a token that lacks {@link META_REQUIRED_SCOPE}. */
export class MetaPermissionsError extends Error {
  constructor(readonly granted: string | null) {
    super(`Meta granted only [${granted ?? ''}]; ${META_REQUIRED_SCOPE} is required`);
    this.name = 'MetaPermissionsError';
  }
}

/** What `GET /debug_token` says about a token, reduced to what we store. */
export interface MetaTokenInfo {
  scopes: string[];
  /** `null` when the token never expires (Meta reports `expires_at: 0`). */
  expiresAt: Date | null;
}

/** Reduce a raw `debug_token` response body; `null` when it isn't one. */
export function parseDebugToken(json: unknown): MetaTokenInfo | null {
  const data = (json as { data?: { scopes?: unknown; expires_at?: unknown } } | null)?.data;
  if (!data || !Array.isArray(data.scopes)) return null;
  const scopes = data.scopes.filter((s): s is string => typeof s === 'string');
  const expiresAt =
    typeof data.expires_at === 'number' && data.expires_at > 0
      ? new Date(data.expires_at * 1000)
      : null;
  return { scopes, expiresAt };
}

/**
 * Whether a stored (space-separated) scope string carries the required
 * permission. Unknown scopes (`null`) pass: when Meta told us nothing, the
 * connect goes through and the first tool call surfaces the real error.
 */
export function hasRequiredMetaScope(scopes: string | null): boolean {
  if (scopes === null) return true;
  return scopes.split(/[\s,]+/).includes(META_REQUIRED_SCOPE);
}

/** A `meta` connection exposed to an LLM as one Meta hosted MCP server. */
export interface MetaMcpServer {
  appSlug: string;
  name: string;
  url: string;
}

/** The token material returned by Meta's OAuth token endpoint. */
export interface MetaTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string | null;
}

/** Everything learned when first connecting a Meta account. */
export interface MetaConnection extends MetaTokenSet {
  /** A stable id for the granted account, used as `externalAccountId`. */
  accountId: string;
  accountName: string | null;
  iconUrl: string;
  appSlug: string;
  appName: string;
}

/** OAuth authorization-server endpoints discovered from the MCP resource. */
interface AuthServerMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
}

interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

/**
 * Talks to Meta's hosted Ads MCP the way {@link PipedreamService} talks to
 * Pipedream, but Meta secures its MCP with plain OAuth 2.1 (PKCE + optional
 * Dynamic Client Registration) rather than an SDK, so this owns that flow:
 * discovering the authorization server, registering ourselves as a client,
 * building the consent URL, exchanging the code, and refreshing tokens.
 *
 * Unlike Pipedream's one shared access token, each Meta connection is its own
 * OAuth grant with its own token, so the token lives on the integration row and
 * every Meta MCP server carries its own `authorization_token`.
 *
 * Persistence is deliberately not here (mirroring PipedreamService's stateless
 * design): {@link IntegrationsService} owns the repo and stores what these
 * methods return.
 */
@Injectable()
export class MetaMcpService implements OnModuleInit {
  private readonly logger = new Logger(MetaMcpService.name);

  /** Cached across the process once discovered/registered. */
  private metadata: AuthServerMetadata | null = null;
  private client: OAuthClient | null = null;

  constructor(private readonly configService: ConfigService<AppConfig, true>) {}

  private get cfg() {
    return this.configService.get('meta', { infer: true });
  }

  onModuleInit(): void {
    if (!this.cfg.mcpUrl) {
      this.logger.warn(
        'META_MCP_URL is not set; Meta Ads connect flows will fail until it is configured.',
      );
    }
    // Meta advertises a `registration_endpoint` but rejects every request to it
    // with `invalid_client_metadata: Dynamic registration is not available for
    // this client`, so the DCR fallback in getClient() can never succeed and our
    // own app id is mandatory. Surface that at boot rather than on a user's click.
    if (!this.cfg.oauthClientId) {
      this.logger.warn(
        'META_OAUTH_CLIENT_ID is not set; Meta rejects dynamic client registration, ' +
          'so every Meta Ads connect attempt will fail until an app id is configured.',
      );
    }
  }

  /** Generate a PKCE verifier and its S256 challenge. */
  static generatePkce(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  /** An opaque, unguessable OAuth `state` value. */
  static generateState(): string {
    return randomBytes(24).toString('base64url');
  }

  /**
   * Discover Meta's authorization server from the MCP resource, following the
   * MCP/OAuth well-known chain: protected-resource metadata → authorization
   * server metadata. Cached after the first success.
   */
  private async discover(): Promise<AuthServerMetadata> {
    if (this.metadata) return this.metadata;
    if (!this.cfg.mcpUrl) {
      throw new ServiceUnavailableException('Meta integration is not configured');
    }

    const resource = await this.fetchWellKnown(this.cfg.mcpUrl, 'oauth-protected-resource');
    const authServer: string =
      (resource?.authorization_servers as string[] | undefined)?.[0] ??
      new URL(this.cfg.mcpUrl).origin;

    const meta = await this.fetchWellKnown(authServer, 'oauth-authorization-server');
    const authorizationEndpoint = meta?.authorization_endpoint as string | undefined;
    const tokenEndpoint = meta?.token_endpoint as string | undefined;
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new ServiceUnavailableException(
        'Meta authorization server metadata is missing required endpoints',
      );
    }

    this.metadata = {
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint: meta?.registration_endpoint as string | undefined,
    };
    return this.metadata;
  }

  /**
   * Fetch a `.well-known/<name>` document for a resource URL. Meta follows the
   * RFC 8414/9728 path-aware layout: for `https://host/ads` the metadata lives
   * at `https://host/.well-known/<name>/ads`, not at the host root — so the
   * resource's path segment is appended after the well-known name.
   */
  private async fetchWellKnown(
    base: string,
    name: string,
  ): Promise<Record<string, unknown> | null> {
    const parsed = new URL(base);
    const suffix = parsed.pathname === '/' ? '' : parsed.pathname;
    const url = `${parsed.origin}/.well-known/${name}${suffix}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(`Failed to fetch ${url}: ${this.messageOf(error)}`);
      return null;
    }
  }

  /**
   * Our OAuth client identity: the configured credentials when present,
   * otherwise a Dynamically Registered client cached for the process.
   */
  private async getClient(): Promise<OAuthClient> {
    if (this.client) return this.client;
    if (this.cfg.oauthClientId) {
      this.client = {
        clientId: this.cfg.oauthClientId,
        clientSecret: this.cfg.oauthClientSecret || undefined,
      };
      return this.client;
    }

    const { registrationEndpoint } = await this.discover();
    if (!registrationEndpoint) {
      throw new ServiceUnavailableException(
        'Meta does not advertise Dynamic Client Registration; set META_OAUTH_CLIENT_ID/SECRET.',
      );
    }

    const res = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Gomer',
        redirect_uris: [this.cfg.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // Meta advertises `token_endpoint_auth_methods_supported: ["none"]`, i.e.
        // a public client authenticated by PKCE rather than a secret.
        token_endpoint_auth_method: 'none',
        scope: this.cfg.scopes,
      }),
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `Meta client registration failed (${res.status}): ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { client_id: string; client_secret?: string };
    this.client = { clientId: body.client_id, clientSecret: body.client_secret };
    return this.client;
  }

  /** Build the Meta consent URL to send the browser to (PKCE S256). */
  async buildAuthorizationUrl(state: string, codeChallenge: string): Promise<string> {
    const { authorizationEndpoint } = await this.discover();
    const { clientId } = await this.getClient();
    const url = new URL(authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    // Facebook Login for Business takes its permissions from the configuration,
    // not the request. The two are mutually exclusive: sending `scope` to an app
    // set up for business login is rejected outright ("App not active"), so pick
    // one based on whether a configuration id is set.
    if (this.cfg.loginConfigId) {
      url.searchParams.set('config_id', this.cfg.loginConfigId);
    } else {
      url.searchParams.set('scope', this.cfg.scopes);
    }
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    this.logger.log(
      `Meta authorize: client_id=${clientId || '(empty)'} redirect_uri=${this.cfg.redirectUri} ` +
        (this.cfg.loginConfigId
          ? `config_id=${this.cfg.loginConfigId}`
          : `scopes=${this.cfg.scopes}`),
    );
    return url.toString();
  }

  /** Exchange an authorization code for tokens and the account identity. */
  async exchangeCode(code: string, codeVerifier: string): Promise<MetaConnection> {
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      code_verifier: codeVerifier,
    });
    // Meta's token response carries no `scope`, so without this the row's scopes
    // stay null and a permission-less token is indistinguishable from a good one.
    if (tokens.scopes === null) {
      const info = await this.inspectToken(tokens.accessToken);
      if (info) {
        tokens.scopes = info.scopes.join(' ');
        tokens.expiresAt ??= info.expiresAt;
      }
    }
    const identity = await this.resolveAccount(tokens.accessToken);
    return {
      ...tokens,
      accountId: identity.accountId,
      accountName: identity.accountName,
      iconUrl: META_ICON_URL,
      appSlug: META_APP_SLUG,
      appName: META_APP_NAME,
    };
  }

  /** Exchange a refresh token for a fresh access token. */
  refreshAccessToken(refreshToken: string): Promise<MetaTokenSet> {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  /** POST to the token endpoint with our client credentials, parse the result. */
  private async tokenRequest(params: Record<string, string>): Promise<MetaTokenSet> {
    const { tokenEndpoint } = await this.discover();
    const { clientId, clientSecret } = await this.getClient();
    const body = new URLSearchParams({ ...params, client_id: clientId });
    if (clientSecret) body.set('client_secret', clientSecret);

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new ServiceUnavailableException(
        `Meta token request failed (${res.status}): ${await res.text()}`,
      );
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
      scopes: json.scope ?? null,
    };
  }

  /**
   * Ask Meta what a token can do and when it dies. Needs an app access token
   * (`id|secret`), so it is skipped when no client secret is configured; any
   * failure is logged and treated as "unknown" rather than blocking the connect.
   */
  private async inspectToken(accessToken: string): Promise<MetaTokenInfo | null> {
    const { clientId, clientSecret } = await this.getClient();
    if (!clientSecret) return null;
    try {
      const url = new URL(`${GRAPH_BASE}/debug_token`);
      url.searchParams.set('input_token', accessToken);
      url.searchParams.set('access_token', `${clientId}|${clientSecret}`);
      const res = await fetch(url);
      if (!res.ok) {
        this.logger.warn(`Meta debug_token failed (${res.status}): ${await res.text()}`);
        return null;
      }
      return parseDebugToken(await res.json());
    } catch (error) {
      this.logger.warn(`Meta debug_token failed: ${this.messageOf(error)}`);
      return null;
    }
  }

  /**
   * Best-effort account identity for the freshly granted token. Meta's token
   * response doesn't carry an ad-account id, so we ask the Graph API who the
   * token belongs to; if that's unavailable we fall back to a random id so the
   * connection is still stored (uniqueness holds, idempotent re-connect won't).
   */
  private async resolveAccount(
    accessToken: string,
  ): Promise<{ accountId: string; accountName: string | null }> {
    try {
      const res = await fetch(
        `${GRAPH_BASE}/me?fields=id,name&access_token=${encodeURIComponent(accessToken)}`,
      );
      if (res.ok) {
        const me = (await res.json()) as { id?: string; name?: string };
        if (me.id) return { accountId: `meta:${me.id}`, accountName: me.name ?? null };
      }
    } catch (error) {
      this.logger.warn(`Meta account lookup failed: ${this.messageOf(error)}`);
    }
    return { accountId: `meta:${randomBytes(12).toString('hex')}`, accountName: null };
  }

  /** True when a stored token is missing or within the refresh skew of expiry. */
  isExpired(expiresAt: Date | null): boolean {
    if (!expiresAt) return false;
    return expiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();
  }

  /**
   * Build the MCP server descriptor for a Meta connection. Named per integration
   * id so two Meta accounts in one workspace produce distinct servers. The caller
   * pairs this with the connection's (freshly refreshed) access token.
   */
  buildMcpServer(integrationId: string): MetaMcpServer {
    return {
      appSlug: META_APP_SLUG,
      name: `meta-${integrationId}`,
      url: this.cfg.mcpUrl,
    };
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
