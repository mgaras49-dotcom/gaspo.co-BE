/**
 * Strongly-typed configuration loaded from environment variables.
 * Consumed via Nest's ConfigService<AppConfig, true>.
 */
export interface AppConfig {
  app: {
    nodeEnv: string;
    port: number;
    frontendUrl: string;
    /**
     * Where this API is reachable from the internet, for links that point at it
     * directly (generated files). Production serves the API under `/api` on the
     * frontend's domain, so that is the default; set PUBLIC_API_URL locally,
     * e.g. to the ngrok tunnel, so Slack can fetch the file.
     */
    publicApiUrl: string;
  };
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    url: string;
    /** Enable TLS for the connection (required by managed Postgres, e.g. DigitalOcean). */
    ssl: boolean;
  };
  redis: {
    host: string;
    port: number;
    /** Full connection URL (e.g. rediss://...). Takes precedence over host/port when set. */
    url: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
  };
  slack: {
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    redirectUri: string;
    scopes: string;
  };
  pipedream: {
    clientId: string;
    clientSecret: string;
    projectId: string;
    environment: string;
  };
  meta: {
    /** Meta's hosted Ads MCP endpoint (the OAuth-protected resource). */
    mcpUrl: string;
    /**
     * OAuth client credentials for talking to Meta's MCP authorization server.
     * Optional: when blank the service self-registers via Dynamic Client
     * Registration and caches the result.
     */
    oauthClientId: string;
    oauthClientSecret: string;
    /** Where Meta bounces the browser back after consent. */
    redirectUri: string;
    /** Space-separated ad scopes to request. */
    scopes: string;
    /**
     * A Facebook Login for Business configuration id. That product carries its
     * permissions in the configuration rather than in the request, so when this
     * is set the consent URL sends `config_id` instead of `scope` — sending
     * `scope` to a business-login app is rejected with "App not active". Leave
     * empty for an app using classic Facebook Login.
     */
    loginConfigId: string;
  };
  ai: {
    anthropicApiKey: string;
    model: string;
    /**
     * An OpenAI-compatible gateway (OpenRouter, a self-hosted OmniRoute, OpenAI
     * itself) serving every non-Anthropic model. Swapping vendors is a base-URL
     * change, not a code change.
     */
    gatewayBaseUrl: string;
    gatewayApiKey: string;
    /**
     * Models the gateway serves, as JSON — the set differs per gateway, so it is
     * declared by the operator rather than hardcoded. See `.env.example`.
     */
    gatewayModels: string;
  };
  images: {
    /**
     * Google AI Studio key for Gemini image generation ("Nano Banana"). Takes
     * precedence over OpenAI when both are set. With neither, Gaspo is not
     * offered the image tool and says it cannot make images.
     */
    geminiApiKey: string;
    geminiModel: string;
    /** OpenAI key for gpt-image generation, used when no Gemini key is set. */
    openaiApiKey: string;
    openaiModel: string;
  };
  billing: {
    /** The platform's own Stripe secret key (top-ups) — NOT a customer's. */
    stripeSecretKey: string;
    /** Signing secret of the Stripe webhook endpoint. */
    stripeWebhookSecret: string;
  };
  superAdmin: {
    /**
     * Email addresses allowed into the platform-owner panel, which reads across
     * every tenant.
     *
     * Deliberately environment state rather than a column or a role. A `users`
     * row is workspace-scoped — the same person is several rows — so a flag
     * there would have to be set once per membership and could be granted by
     * anything that can write the table. An allowlist can only be changed by
     * whoever can change the deployment's environment, which is the same
     * authority that owns the data the panel exposes.
     */
    emails: string[];
  };
}

/**
 * Parse a comma-separated address list into a normalized allowlist.
 *
 * Lowercased because Slack reports a profile's email in whatever case the user
 * typed it, and an owner locked out of their own panel by a capital letter is a
 * support ticket with no visible cause.
 */
const parseEmailList = (raw: string): string[] =>
  raw
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

export const configuration = (): AppConfig => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3000', 10),
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    publicApiUrl:
      process.env.PUBLIC_API_URL ||
      `${(process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/api`,
  },
  database: {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    name: process.env.DATABASE_NAME ?? 'gomer',
    user: process.env.DATABASE_USER ?? 'postgres',
    password: process.env.DATABASE_PASSWORD ?? 'password',
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:password@localhost:5432/gomer',
    ssl: process.env.DATABASE_SSL === 'true',
  },
  redis: {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    url: process.env.REDIS_URL ?? '',
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? 'super-secret-key',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'refresh-secret-key',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },
  slack: {
    clientId: process.env.SLACK_CLIENT_ID ?? '',
    clientSecret: process.env.SLACK_CLIENT_SECRET ?? '',
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? '',
    redirectUri: process.env.SLACK_REDIRECT_URI ?? 'http://localhost:3000/auth/slack/callback',
    scopes:
      process.env.SLACK_SCOPES ??
      'app_mentions:read,chat:write,reactions:write,im:history,im:read,im:write,channels:history,groups:history,users:read,users:read.email,team:read,files:read',
  },
  pipedream: {
    clientId: process.env.PIPEDREAM_CLIENT_ID ?? '',
    clientSecret: process.env.PIPEDREAM_CLIENT_SECRET ?? '',
    projectId: process.env.PIPEDREAM_PROJECT_ID ?? '',
    environment: process.env.PIPEDREAM_ENVIRONMENT ?? 'development',
  },
  meta: {
    mcpUrl: process.env.META_MCP_URL ?? 'https://mcp.facebook.com/ads',
    oauthClientId: process.env.META_OAUTH_CLIENT_ID ?? '',
    oauthClientSecret: process.env.META_OAUTH_CLIENT_SECRET ?? '',
    redirectUri:
      process.env.META_REDIRECT_URI ?? 'http://localhost:3000/integrations/meta/callback',
    scopes: process.env.META_SCOPES ?? 'ads_management ads_read business_management',
    loginConfigId: process.env.META_LOGIN_CONFIG_ID ?? '',
  },
  ai: {
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.AI_MODEL ?? 'claude-sonnet-5',
    gatewayBaseUrl: process.env.AI_GATEWAY_BASE_URL ?? '',
    gatewayApiKey: process.env.AI_GATEWAY_API_KEY ?? '',
    gatewayModels: process.env.AI_GATEWAY_MODELS ?? '',
  },
  images: {
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
    geminiModel: process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1',
  },
  billing: {
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },
  superAdmin: {
    emails: parseEmailList(process.env.SUPER_ADMIN_EMAILS ?? ''),
  },
});
