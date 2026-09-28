/**
 * Minimal typings for the slice of the Slack Events API we consume. Slack sends
 * far more fields than these; we type only what the chat handler reads.
 */

/** A single message-like event (app_mention or a DM message). */
export interface SlackMessageEvent {
  type: string;
  /** Present on bot-authored messages; used to ignore our own posts. */
  bot_id?: string;
  subtype?: string;
  user?: string;
  text?: string;
  channel?: string;
  /** "im" for direct messages, "channel"/"group" otherwise. */
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  /** Files uploaded with the message; such a message has subtype `file_share`. */
  files?: SlackFile[];
}

/** The slice of a Slack file object we read to download an attachment. */
export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  /**
   * `hosted` for an upload, `snippet` for a text snippet; `external` for a
   * linked Drive or Dropbox file, `tombstone` once deleted, `hidden_by_limit`
   * past a free plan's history — none of those last three can be downloaded.
   */
  mode?: string;
  url_private?: string;
  url_private_download?: string;
  /** `check_file_info` when Slack sends only the id (Slack Connect channels). */
  file_access?: string;
}

/** The slice of a Slack user object we read from a `team_join` event. */
export interface SlackUserObject {
  id: string;
  team_id?: string;
  name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    real_name?: string;
    display_name?: string;
    email?: string;
  };
}

/** Fired when a new member joins the workspace — drives the onboarding DM. */
export interface SlackTeamJoinEvent {
  type: 'team_join';
  user: SlackUserObject;
}

/** Any event we type; the handler narrows on `type` before reading fields. */
export type SlackEvent = SlackMessageEvent | SlackTeamJoinEvent;

/** The outer envelope Slack POSTs to the events endpoint. */
export interface SlackEventEnvelope {
  type: 'url_verification' | 'event_callback' | string;
  /** Present on url_verification handshakes. */
  challenge?: string;
  team_id?: string;
  event_id?: string;
  event?: SlackEvent;
}
