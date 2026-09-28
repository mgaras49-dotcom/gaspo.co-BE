import * as crypto from 'crypto';
import { HttpService } from '@nestjs/axios';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { SLACK_API_BASE_URL, SLACK_OAUTH_AUTHORIZE_URL } from '../common/constants';
import { AppConfig } from '../config/configuration';
import {
  SlackEmailLookup,
  SlackIdentity,
  SlackOAuthAccessResponse,
  SlackTeamMember,
  SlackUserInfoResponse,
  SlackUserLookupResponse,
} from './interfaces/slack-oauth.interface';

/** A shared file's bytes, or why they could not be fetched. */
export type SlackFileDownload =
  | { ok: true; data: Buffer }
  | { ok: false; reason: 'no_access' | 'too_large' | 'gone' | 'failed' };

/** The name a Slack member goes by: display name, then real name, then handle. */
function slackDisplayName(user: NonNullable<SlackUserLookupResponse['user']>): string {
  const profile = user.profile ?? {};
  return profile.display_name || profile.real_name || user.real_name || user.name || user.id;
}

/**
 * Wrapper over the Slack Web API: the OAuth install/exchange flow, request
 * signature verification for the Events API, and posting bot messages.
 */
@Injectable()
export class SlackService {
  private readonly logger = new Logger(SlackService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Verify a Slack request signature (v0 scheme) over the raw request body.
   * Rejects requests older than 5 minutes to blunt replay attacks. Returns
   * false (rather than throwing) so the caller decides the HTTP response.
   */
  verifySignature(
    signature: string | undefined,
    timestamp: string | undefined,
    rawBody: Buffer,
  ): boolean {
    const { signingSecret } = this.configService.get('slack', { infer: true });
    if (!signingSecret || !signature || !timestamp) return false;

    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(age) || age > 60 * 5) return false;

    const base = `v0:${timestamp}:${rawBody.toString('utf8')}`;
    const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

    const expectedBuf = Buffer.from(expected);
    const actualBuf = Buffer.from(signature);
    return (
      expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)
    );
  }

  /**
   * Post a message to a Slack channel (or DM) as the workspace's bot. Threads
   * the reply when a parent timestamp is given. Best-effort: logs and returns
   * the new message timestamp (so it can be edited later) or null on failure.
   */
  async postMessage(
    botToken: string,
    channel: string,
    text: string,
    threadTs?: string,
    blocks?: unknown[],
  ): Promise<string | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<{ ok: boolean; ts?: string; error?: string }>(
          `${SLACK_API_BASE_URL}/chat.postMessage`,
          {
            channel,
            text,
            ...(threadTs ? { thread_ts: threadTs } : {}),
            ...(blocks ? { blocks } : {}),
          },
          {
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        ),
      );
      if (!response.data.ok) {
        this.logger.warn(`chat.postMessage failed: ${response.data.error ?? 'unknown_error'}`);
        return null;
      }
      return response.data.ts ?? null;
    } catch (error) {
      this.logger.warn(
        `chat.postMessage error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Edit an existing bot message in place (chat.update). Used to swap a
   * "thinking…" placeholder for the final answer. Best-effort: logs and returns
   * false on failure rather than throwing.
   */
  async updateMessage(
    botToken: string,
    channel: string,
    ts: string,
    text: string,
    blocks?: unknown[],
  ): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<{ ok: boolean; error?: string }>(
          `${SLACK_API_BASE_URL}/chat.update`,
          { channel, ts, text, ...(blocks ? { blocks } : {}) },
          {
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        ),
      );
      if (!response.data.ok) {
        this.logger.warn(`chat.update failed: ${response.data.error ?? 'unknown_error'}`);
      }
      return response.data.ok;
    } catch (error) {
      this.logger.warn(
        `chat.update error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Reply to a Slack interaction privately via its `response_url` — an ephemeral
   * note only the clicking user sees (e.g. "only the requester can approve").
   * The response_url is pre-authorized, so no bot token is needed. Best-effort.
   */
  async respondEphemeral(responseUrl: string, text: string): Promise<void> {
    try {
      await firstValueFrom(
        this.httpService.post(responseUrl, {
          response_type: 'ephemeral',
          replace_original: false,
          text,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `response_url post error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Open (or fetch) the IM channel with a user so the bot can DM them
   * (conversations.open). Needs the `im:write` scope. Best-effort: logs and
   * returns the channel id, or null on failure.
   */
  async openDm(botToken: string, userId: string): Promise<string | null> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<{ ok: boolean; error?: string; channel?: { id?: string } }>(
          `${SLACK_API_BASE_URL}/conversations.open`,
          { users: userId },
          {
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        ),
      );
      if (!response.data.ok || !response.data.channel?.id) {
        this.logger.warn(`conversations.open failed: ${response.data.error ?? 'unknown_error'}`);
        return null;
      }
      return response.data.channel.id;
    } catch (error) {
      this.logger.warn(
        `conversations.open error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Deliver a message to a destination that may be a channel/group id or a user
   * id (Slack user ids start with U or W) — opening a DM first in the latter
   * case. Used for proactive posts (scheduled tasks, onboarding). Best-effort:
   * returns the new message timestamp or null.
   */
  async deliver(botToken: string, destination: string, text: string): Promise<string | null> {
    const channel = /^[UW]/.test(destination)
      ? await this.openDm(botToken, destination)
      : destination;
    if (!channel) return null;
    return this.postMessage(botToken, channel, text);
  }

  /**
   * Add an emoji reaction to a message (reactions.add) — used as a lightweight
   * "processing" indicator on the user's own message instead of a placeholder
   * reply. `name` is the bare emoji name (no colons). Best-effort: logs and
   * returns false on failure (e.g. `already_reacted`, missing reactions:write).
   */
  addReaction(
    botToken: string,
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<boolean> {
    return this.react('reactions.add', botToken, channel, timestamp, name);
  }

  /** Remove a previously added reaction (reactions.remove). Best-effort. */
  removeReaction(
    botToken: string,
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<boolean> {
    return this.react('reactions.remove', botToken, channel, timestamp, name);
  }

  private async react(
    method: 'reactions.add' | 'reactions.remove',
    botToken: string,
    channel: string,
    timestamp: string,
    name: string,
  ): Promise<boolean> {
    try {
      const response = await firstValueFrom(
        this.httpService.post<{ ok: boolean; error?: string }>(
          `${SLACK_API_BASE_URL}/${method}`,
          { channel, timestamp, name },
          {
            headers: {
              Authorization: `Bearer ${botToken}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
          },
        ),
      );
      // `already_reacted` / `no_reaction` are benign races, not real failures.
      if (
        !response.data.ok &&
        !['already_reacted', 'no_reaction'].includes(response.data.error ?? '')
      ) {
        this.logger.warn(`${method} failed: ${response.data.error ?? 'unknown_error'}`);
      }
      return response.data.ok;
    } catch (error) {
      this.logger.warn(
        `${method} error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Download a file a user shared, as the bot. Needs the `files:read` scope, and
   * a token without it is not refused outright: Slack answers with its sign-in
   * page instead of the file, so HTML back for a file that is not HTML means no
   * access. The token only ever goes to Slack's own file host.
   */
  async downloadFile(
    botToken: string,
    url: string,
    maxBytes: number,
    mimetype: string | null,
  ): Promise<SlackFileDownload> {
    let host: URL;
    try {
      host = new URL(url);
    } catch {
      return { ok: false, reason: 'failed' };
    }
    if (host.protocol !== 'https:' || !/(^|\.)slack\.com$/.test(host.hostname)) {
      this.logger.warn(`Refusing to send the bot token to ${host.hostname} for a file download`);
      return { ok: false, reason: 'failed' };
    }
    try {
      const response = await firstValueFrom(
        this.httpService.get<ArrayBuffer>(url, {
          headers: { Authorization: `Bearer ${botToken}` },
          responseType: 'arraybuffer',
          maxContentLength: maxBytes,
          timeout: 30000,
        }),
      );
      const contentType = String(response.headers['content-type'] ?? '');
      if (contentType.startsWith('text/html') && !mimetype?.startsWith('text/html')) {
        return { ok: false, reason: 'no_access' };
      }
      return { ok: true, data: Buffer.from(response.data) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('maxContentLength')) return { ok: false, reason: 'too_large' };
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403) return { ok: false, reason: 'no_access' };
      if (status === 404) return { ok: false, reason: 'gone' };
      this.logger.warn(`Slack file download failed: ${message}`);
      return { ok: false, reason: 'failed' };
    }
  }

  /** Count the human members of the Slack workspace. Null on failure, like `listMembers`. */
  async countMembers(botToken: string): Promise<number | null> {
    const members = await this.listMembers(botToken);
    return members === null ? null : members.length;
  }

  /**
   * The human members of the Slack workspace (users.list), excluding bots,
   * Slackbot, and deactivated accounts. Paginates through every page. Needs the
   * `users:read` scope, plus `users:read.email` for the addresses.
   * Best-effort: returns null on failure so callers degrade.
   */
  async listMembers(botToken: string): Promise<SlackTeamMember[] | null> {
    try {
      let cursor: string | undefined;
      const members: SlackTeamMember[] = [];
      do {
        const response = await firstValueFrom(
          this.httpService.get<{
            ok: boolean;
            error?: string;
            members?: Array<NonNullable<SlackUserLookupResponse['user']>>;
            response_metadata?: { next_cursor?: string };
          }>(`${SLACK_API_BASE_URL}/users.list`, {
            params: { limit: 200, ...(cursor ? { cursor } : {}) },
            headers: { Authorization: `Bearer ${botToken}` },
          }),
        );
        if (!response.data.ok) {
          this.logger.warn(`users.list failed: ${response.data.error ?? 'unknown_error'}`);
          return null;
        }
        for (const member of response.data.members ?? []) {
          if (member.is_bot || member.deleted || member.id === 'USLACKBOT') continue;
          const profile = member.profile ?? {};
          members.push({
            id: member.id,
            name: slackDisplayName(member),
            email: profile.email ?? null,
            avatarUrl: profile.image_192 ?? profile.image_512 ?? null,
          });
        }
        cursor = response.data.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return members;
    } catch (error) {
      this.logger.warn(
        `users.list error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Resolve a Slack workspace member by the email on their Slack account
   * (users.lookupByEmail). Needs the `users:read.email` scope. Unlike the other
   * best-effort helpers this reports *why* it found nobody, because the admin
   * inviting that address is told different things for "not in your Slack"
   * and "Slack didn't answer".
   */
  async lookupUserByEmail(botToken: string, email: string): Promise<SlackEmailLookup> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<SlackUserLookupResponse>(`${SLACK_API_BASE_URL}/users.lookupByEmail`, {
          params: { email },
          headers: { Authorization: `Bearer ${botToken}` },
        }),
      );
      const user = response.data.user;
      if (!response.data.ok || !user) {
        const error = response.data.error ?? 'unknown_error';
        if (error === 'users_not_found') return { status: 'not_found' };
        this.logger.warn(`users.lookupByEmail failed: ${error}`);
        return { status: 'error', error };
      }
      const profile = user.profile ?? {};
      return {
        status: 'found',
        id: user.id,
        name: slackDisplayName(user),
        email: profile.email ?? email,
        avatarUrl: profile.image_512 ?? profile.image_192 ?? null,
        deleted: user.deleted === true,
        isBot: user.is_bot === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`users.lookupByEmail error: ${message}`);
      return { status: 'error', error: message };
    }
  }

  /** Builds the Slack OAuth "Add to Slack" authorize URL. */
  buildInstallUrl(state: string): string {
    const slack = this.configService.get('slack', { infer: true });
    const params = new URLSearchParams({
      client_id: slack.clientId,
      scope: slack.scopes,
      redirect_uri: slack.redirectUri,
      state,
    });
    return `${SLACK_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * Exchanges an OAuth code for tokens and resolves the full Slack identity
   * (team + authenticating user profile).
   */
  async exchangeCodeForIdentity(code: string): Promise<SlackIdentity> {
    const slack = this.configService.get('slack', { infer: true });

    const tokenResponse = await firstValueFrom(
      this.httpService.post<SlackOAuthAccessResponse>(
        `${SLACK_API_BASE_URL}/oauth.v2.access`,
        new URLSearchParams({
          client_id: slack.clientId,
          client_secret: slack.clientSecret,
          code,
          redirect_uri: slack.redirectUri,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      ),
    );

    const data = tokenResponse.data;
    if (!data.ok || !data.team || !data.authed_user) {
      this.logger.error(`Slack oauth.v2.access failed: ${data.error ?? 'unknown_error'}`);
      throw new InternalServerErrorException('Slack OAuth exchange failed');
    }

    const botToken = data.access_token ?? null;
    const profile = await this.fetchUserProfile(data.authed_user.id, botToken);

    return {
      slackTeamId: data.team.id,
      teamName: data.team.name,
      slackUserId: data.authed_user.id,
      name: profile.name,
      email: profile.email,
      avatarUrl: profile.avatarUrl,
      botToken,
    };
  }

  /**
   * A member's Slack profile via users.info, for provisioning a workspace user
   * from an inbound message. Falls back to the bare id when the call fails.
   */
  getUserProfile(
    botToken: string,
    slackUserId: string,
  ): Promise<{ name: string; email: string | null; avatarUrl: string | null }> {
    return this.fetchUserProfile(slackUserId, botToken);
  }

  private async fetchUserProfile(
    slackUserId: string,
    botToken: string | null,
  ): Promise<{ name: string; email: string | null; avatarUrl: string | null }> {
    // Without a bot token we cannot call users.info; fall back to the id.
    if (!botToken) {
      return { name: slackUserId, email: null, avatarUrl: null };
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<SlackUserInfoResponse>(`${SLACK_API_BASE_URL}/users.info`, {
          params: { user: slackUserId },
          headers: { Authorization: `Bearer ${botToken}` },
        }),
      );

      const user = response.data.user;
      if (!response.data.ok || !user) {
        return { name: slackUserId, email: null, avatarUrl: null };
      }

      const profile = user.profile ?? {};
      return {
        name:
          profile.display_name || profile.real_name || user.real_name || user.name || slackUserId,
        email: profile.email ?? null,
        avatarUrl: profile.image_512 ?? profile.image_192 ?? null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to fetch Slack profile for ${slackUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { name: slackUserId, email: null, avatarUrl: null };
    }
  }
}
