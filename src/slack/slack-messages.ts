/**
 * Canned proactive messages Gaspo sends unprompted — the onboarding intro a new
 * member (or the installer) receives. Written in Slack mrkdwn (single-asterisk
 * bold, `_italics_`, `• ` bullets), not Markdown.
 */

/** A first name to greet by, falling back to a friendly default. */
function firstName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

/**
 * The intro DM Gaspo sends when it first meets someone — on install (to the
 * installer) and when a new member joins the workspace. `isInstaller` adds a
 * line about the daily check-in that only the installing admin needs to know.
 */
export function buildWelcomeMessage(
  name: string | null | undefined,
  options: { isInstaller?: boolean } = {},
): string {
  const lines = [
    `Hi ${firstName(name)} :wave:, great to meet you. I'm *Gaspo*, your new AI coworker. Here are three ways to work with me:`,
    '',
    ':speech_balloon: *DM me here* — just message me like a coworker. Research, analysis, reports, automation — anything.',
    ":mega: *@Gaspo in any channel* — mention me in context and I'll jump in with the full thread as background.",
    ":electric_plug: *I connect to 3000+ tools* — Gmail, GitHub, Stripe, HubSpot, Google Ads, and more. Just tell me what you need and I'll figure out access.",
    '',
    'Try one now — just reply here:',
    '• _Check my Gmail for anything urgent this week and summarize it_',
    '• _Summarize the last week of activity in one of our channels_',
  ];

  if (options.isInstaller) {
    lines.push(
      '',
      "I'll also do a short daily check-in here to suggest ways I can help — tell me to dial it back anytime.",
    );
  }

  lines.push('', "Or just tell me what you need — I'll take it from there :rocket:");
  return lines.join('\n');
}

/**
 * The DM a teammate gets when an admin adds them from the dashboard. They are
 * already a member by the time it is sent, so it tells them where Gaspo is
 * rather than asking them to accept anything. `dashboardUrl` is the sign-in
 * page; `<...>` is Slack's auto-link syntax.
 */
export function buildInviteMessage(
  inviterName: string | null | undefined,
  workspaceName: string,
  dashboardUrl: string,
): string {
  const inviter = (inviterName ?? '').trim() || 'A teammate';
  return [
    `Hi :wave: *${inviter}* added you to *${workspaceName}* on Gaspo, your team's AI coworker.`,
    '',
    ':speech_balloon: *DM me here* — just message me like a coworker. Research, analysis, reports, automation — anything.',
    `:bar_chart: *Open the dashboard* at <${dashboardUrl}> — sign in with Slack to see usage, connected tools and your team.`,
    '',
    'Try one now — just reply here:',
    '• _Summarize the last week of activity in one of our channels_',
  ].join('\n');
}

/**
 * The DM carrying a sign-in link for a Space (an app Gaspo built). Someone
 * typed this teammate's email on the app's sign-in page, so it says what to do
 * if that was not them. The app name is model-written, so it is escaped before
 * it goes inside Slack's `<url|label>` link syntax.
 */
export function buildSpaceSignInMessage(spaceName: string, link: string): string {
  const name = spaceName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    `:key: Here's your sign-in link for *${name}*: <${link}|Open ${name}>`,
    '',
    "It works once and expires in 30 minutes. If you didn't ask for it, you can ignore this message.",
  ].join('\n');
}

/**
 * action_id values Slack sends back when an approval button is clicked.
 *
 * These keep the old `gomer_` prefix deliberately: approval cards already posted
 * in Slack carry it in their payload, and renaming would make those buttons
 * silently no-op. The prefix is opaque to Slack — it is never shown to a user.
 */
export const APPROVE_ACTION_ID = 'gomer_approve';
export const CANCEL_ACTION_ID = 'gomer_cancel';

/** A minimal subset of Slack Block Kit blocks we build. */
export type SlackBlock = Record<string, unknown>;

/**
 * The approval card shown under a reply when Gaspo wants to take a gated write
 * action (e.g. a Meta Ads change). `text` is Gaspo's mrkdwn description of what
 * it will do; `token` identifies the pending action for the button callback.
 */
export function buildApprovalBlocks(text: string, token: string, label: string): SlackBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      block_id: `approval:${token}`,
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: `Approve: ${label}`, emoji: true },
          action_id: APPROVE_ACTION_ID,
          value: token,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel', emoji: true },
          action_id: CANCEL_ACTION_ID,
          value: token,
        },
      ],
    },
  ];
}

/** The card the approval message becomes once it's been resolved (buttons removed). */
export function buildResolvedBlocks(text: string, footer: string): SlackBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: footer }] },
  ];
}

/** Image types Slack's image block will render. */
const SLACK_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif']);

/**
 * Image blocks for pictures Gaspo generated, shown under its reply. Slack
 * fetches each `url` itself, so it must be publicly reachable; files of other
 * types (PDFs) are linked in the reply text instead and are skipped here.
 */
export function buildImageBlocks(
  files: Array<{ name: string; mimetype: string; url: string }>,
): SlackBlock[] {
  return files
    .filter((file) => SLACK_IMAGE_TYPES.has(file.mimetype))
    .slice(0, 10)
    .map((file) => ({
      type: 'image',
      image_url: file.url,
      alt_text: file.name.slice(0, 2000),
      title: { type: 'plain_text', text: file.name.slice(0, 2000), emoji: false },
    }));
}
