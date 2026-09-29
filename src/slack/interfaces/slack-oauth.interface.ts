/** Subset of the Slack `oauth.v2.access` response we rely on. */
export interface SlackOAuthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id: string; name: string };
  authed_user?: {
    id: string;
    scope?: string;
    access_token?: string;
    token_type?: string;
  };
}

/** Subset of the Slack `users.info` response we rely on. */
export interface SlackUserInfoResponse {
  ok: boolean;
  error?: string;
  user?: {
    id: string;
    name?: string;
    real_name?: string;
    /** IANA timezone from the member's Slack settings, e.g. "Australia/Sydney". */
    tz?: string;
    profile?: {
      real_name?: string;
      display_name?: string;
      email?: string;
      image_192?: string;
      image_512?: string;
    };
  };
}

/** Subset of the Slack `users.lookupByEmail` response we rely on. */
export interface SlackUserLookupResponse {
  ok: boolean;
  error?: string;
  user?: {
    id: string;
    name?: string;
    real_name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    profile?: {
      real_name?: string;
      display_name?: string;
      email?: string;
      image_192?: string;
      image_512?: string;
    };
  };
}

/**
 * Outcome of resolving an email to a Slack member. "Not found" and "the call
 * failed" are kept apart on purpose: the first is something the admin can fix
 * (add the person to Slack), the second is something we should retry.
 */
export type SlackEmailLookup =
  | {
      status: 'found';
      id: string;
      name: string;
      email: string | null;
      avatarUrl: string | null;
      /** Deactivated in Slack — cannot be messaged or sign in. */
      deleted: boolean;
      isBot: boolean;
    }
  | { status: 'not_found' }
  | { status: 'error'; error: string };

/** A person on the workspace's Slack team, as `users.list` reports them. */
export interface SlackTeamMember {
  id: string;
  name: string;
  /** Null when Slack withholds it (the `users:read.email` scope is missing). */
  email: string | null;
  avatarUrl: string | null;
}

/** Normalized Slack identity used by the auth flow. */
export interface SlackIdentity {
  slackTeamId: string;
  teamName: string;
  slackUserId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  botToken: string | null;
}
