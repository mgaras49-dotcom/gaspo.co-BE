import { Injectable, Logger } from '@nestjs/common';
import { AiService } from '../ai/ai.service';
import { MAX_ATTACHMENT_BYTES, MAX_RUN_ATTACHMENT_BYTES } from '../ai/attachments';
import { MessageRole, UserRole } from '../common/enums';
import { MessagesService } from '../memory/messages.service';
import { UsersService } from '../users/users.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import {
  SlackEventEnvelope,
  SlackMessageEvent,
  SlackTeamJoinEvent,
} from './interfaces/slack-event.interface';
import {
  AttachmentBudget,
  attachmentRef,
  composePrompt,
  FileDownloader,
  loadAttachments,
  resolveHistory,
} from './slack-attachments';
import { buildApprovalBlocks, buildWelcomeMessage } from './slack-messages';
import { SlackInteractionsService } from './slack-interactions.service';
import { SlackService } from './slack.service';

/**
 * Emoji reacted onto the user's message while Gaspo works, then removed once the
 * answer is posted. A bare Slack emoji name (no colons) — swap for a custom
 * workspace spinner (e.g. 'loading') if one is installed.
 */
const PROCESSING_REACTION = 'hourglass_flowing_sand';

/**
 * Which conversation a message belongs to, and which one branches off it. Both
 * the replayed history and the run's attached apps hang off these keys.
 *
 * A reply inside a thread is keyed by that thread wherever it lives, DMs
 * included. Keying a whole DM by its channel put every thread in it on one
 * history: a Google Ads thread, resumed after a detour into a Meta thread,
 * answered with the Meta campaign's budget and described its "ad sets" — those
 * turns were simply the most recent ones under the shared key, and nothing in
 * the transcript marked them as another conversation's.
 *
 * A DM message that is not in a thread has no thread of its own to key by, so
 * those stay keyed by the per-user channel and read as one rolling conversation
 * — which is what an unthreaded DM looks like to the person typing it. Since we
 * answer such a message in a thread hanging off it, the next turn usually
 * arrives keyed by that new thread instead, with none of the rolling history
 * behind it; `branchThreadId` names it so this turn can be mirrored there as its
 * opening. Without that the conversation restarts the moment the user replies
 * where we invited them to.
 */
export function conversationKeys(
  message: Pick<SlackMessageEvent, 'channel_type' | 'thread_ts' | 'ts'>,
  channel: string,
): { memoryThreadId: string | undefined; branchThreadId: string | null } {
  const threadTs = message.thread_ts ?? message.ts;
  const rollingDm = message.channel_type === 'im' && !message.thread_ts;
  return {
    memoryThreadId: rollingDm ? channel : threadTs,
    // Guard the degenerate case where a message carries no ts: there is no
    // thread to branch into, and mirroring into the channel key would duplicate
    // the turn we just wrote there.
    branchThreadId: rollingDm && threadTs && threadTs !== channel ? threadTs : null,
  };
}

/**
 * Turns inbound Slack messages into Gaspo runs. An @-mention in a channel or a
 * DM to the bot is treated as a prompt: we resolve the sender to a workspace
 * member (so their connected apps are available), run it through {@link AiService},
 * and post the answer back in-thread. Processing is fire-and-forget — the
 * controller has already acked Slack — so all failures are logged, not thrown.
 */
@Injectable()
export class SlackEventsService {
  private readonly logger = new Logger(SlackEventsService.name);

  /** Recently handled Slack event ids, to drop duplicate deliveries/retries. */
  private readonly seenEventIds = new Set<string>();

  constructor(
    private readonly slackService: SlackService,
    private readonly workspacesService: WorkspacesService,
    private readonly usersService: UsersService,
    private readonly aiService: AiService,
    private readonly interactions: SlackInteractionsService,
    private readonly messagesService: MessagesService,
  ) {}

  /** Handle an `event_callback` envelope. Safe to call without awaiting. */
  async handleEventCallback(envelope: SlackEventEnvelope): Promise<void> {
    const event = envelope.event;
    if (!event) return;

    // Drop duplicate deliveries/retries early, before any handler runs.
    if (envelope.event_id) {
      if (this.seenEventIds.has(envelope.event_id)) return;
      this.rememberEventId(envelope.event_id);
    }

    // A new member joining gets a proactive onboarding DM, not a prompt run.
    if (event.type === 'team_join') {
      await this.handleTeamJoin(envelope.team_id, event as SlackTeamJoinEvent);
      return;
    }

    const message = event as SlackMessageEvent;
    if (!this.isHandledMessage(message)) return;

    const teamId = envelope.team_id;
    const channel = message.channel;
    const text = this.cleanText(message.text ?? '');
    // A file sent with no words is still a request: "here, read this".
    const files = message.files ?? [];
    if (!teamId || !channel || (!text && !files.length)) return;

    const workspace = await this.workspacesService.findBySlackTeamId(teamId);
    if (!workspace?.slackBotToken) {
      this.logger.warn(`No workspace/bot token for Slack team ${teamId}`);
      return;
    }
    const botToken = workspace.slackBotToken;
    // Reply in the same thread for mentions; DMs have no parent to thread under.
    const threadTs = message.thread_ts ?? message.ts;
    const messageTs = message.ts;
    const { memoryThreadId, branchThreadId } = conversationKeys(message, channel);

    // Signal "processing" by reacting to the user's own message rather than
    // posting a placeholder reply; the reaction is cleared once we answer.
    if (messageTs) {
      await this.slackService.addReaction(botToken, channel, messageTs, PROCESSING_REACTION);
    }

    try {
      let member = message.user
        ? await this.usersService.findBySlackIdentity(workspace.id, message.user)
        : null;
      // A sender with no member row yet (they messaged before ever signing in)
      // is provisioned from their Slack profile, so the run knows who is asking
      // and their private connections resolve — otherwise they would silently
      // run as an anonymous member seeing only shared team accounts.
      if (!member && message.user) {
        try {
          const profile = await this.slackService.getUserProfile(botToken, message.user);
          member = await this.usersService.upsertFromSlack({
            workspaceId: workspace.id,
            slackUserId: message.user,
            name: profile.name,
            email: profile.email,
            avatarUrl: profile.avatarUrl,
            // Never let a merely-messaging sender become the founding admin.
            role: UserRole.MEMBER,
          });
        } catch (error) {
          this.logger.warn(
            `Could not provision Slack sender ${message.user}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Files are fetched now, with the bot token, and again whenever a later
      // turn replays this one. This message's files are served first, then the
      // history's newest-first, out of one budget sized to what a request holds.
      const download: FileDownloader = (ref) =>
        this.slackService.downloadFile(botToken, ref.url, MAX_ATTACHMENT_BYTES, ref.mimetype);
      const budget: AttachmentBudget = { remaining: MAX_RUN_ATTACHMENT_BYTES };
      const refs = files.map(attachmentRef);
      const current = await loadAttachments(
        refs.flatMap((ref) => (ref.ok ? [ref.ref] : [])),
        download,
        budget,
      );
      const prompt = composePrompt(
        text,
        current.loaded.map((ref) => ref.name),
        [...refs.flatMap((ref) => (ref.ok ? [] : [ref.problem])), ...current.problems],
      );

      // Load prior turns BEFORE persisting this one, so the new prompt isn't
      // duplicated in its own history. Both calls are best-effort inside
      // MessagesService — memory never blocks a reply.
      const history = memoryThreadId
        ? await resolveHistory(
            await this.messagesService.getThread(workspace.id, memoryThreadId),
            download,
            budget,
          )
        : [];
      for (const threadId of [memoryThreadId, branchThreadId]) {
        if (!threadId) continue;
        await this.messagesService.appendTurn(
          workspace.id,
          threadId,
          member?.id ?? null,
          MessageRole.USER,
          prompt,
          current.loaded,
        );
      }

      const senderId = message.user;
      const result = await this.aiService.run(workspace.id, member?.id ?? null, prompt, {
        sourceName: 'slack',
        history,
        attachments: current.attachments,
        // Same key as the conversation memory: connected apps stay attached for
        // the life of a thread rather than being re-decided per message.
        conversationId: memoryThreadId,
        branchConversationId: branchThreadId,
        // Slack can approve gated writes with interactive buttons, so defer them
        // out of band rather than using the soft `confirmed` flag.
        confirmVia: 'buttons',
        // Resolved lazily — only the workspace-stats tool needs it, so we avoid
        // a users.list call on every ordinary message.
        fetchMemberCount: () => this.slackService.countMembers(botToken),
        // A task set up from this message posts back to the same channel or DM,
        // on the sender's own clock.
        slackChannelId: channel,
        fetchRequesterTimezone: senderId
          ? () => this.slackService.getUserTimezone(botToken, senderId)
          : undefined,
      });

      const answer = result.answer || "I couldn't come up with a response to that.";

      // Record Gaspo's side of the turn so follow-ups in this thread see it, and
      // in the thread this answer opens, which is where the follow-up will land.
      for (const threadId of [memoryThreadId, branchThreadId]) {
        if (!threadId || !result.answer) continue;
        await this.messagesService.appendTurn(
          workspace.id,
          threadId,
          null,
          MessageRole.ASSISTANT,
          result.answer,
        );
      }

      // A gated write is pending: post Gaspo's description with Approve/Cancel
      // buttons and stash the action for the interaction callback. Requires a
      // known requester (to gate who can approve); otherwise fall back to text.
      if (result.pendingAction && message.user) {
        const token = await this.interactions.storePending({
          workspaceId: workspace.id,
          requesterUserId: member?.id ?? null,
          requesterSlackId: message.user,
          requesterName: member?.name ?? 'the requester',
          teamId,
          channel,
          threadTs,
          messageTs: '',
          toolName: result.pendingAction.tool,
          input: result.pendingAction.input,
          label: result.pendingAction.label,
          answer,
        });
        const ts = await this.slackService.postMessage(
          botToken,
          channel,
          answer,
          threadTs,
          buildApprovalBlocks(answer, token, result.pendingAction.label),
        );
        // Record the posted message ts so the callback can edit it in place.
        if (ts) await this.interactions.attachMessageTs(token, ts);
      } else {
        await this.slackService.postMessage(botToken, channel, answer, threadTs);
      }
      // Generated images show under the reply; PDFs are linked in its text.
      await this.slackService.postImages(botToken, channel, result.files, threadTs);
    } catch (error) {
      this.logger.error(
        `Failed to handle Slack message: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.slackService.postMessage(
        botToken,
        channel,
        '⚠️ Sorry, something went wrong handling that. Please try again.',
        threadTs,
      );
    } finally {
      // Clear the processing indicator whether we answered or errored.
      if (messageTs) {
        await this.slackService.removeReaction(botToken, channel, messageTs, PROCESSING_REACTION);
      }
    }
  }

  /**
   * Greet a newly joined member with an onboarding DM — Gaspo "messaging first".
   * Best-effort: bots/deactivated joiners and workspaces we can't resolve are
   * skipped silently.
   */
  private async handleTeamJoin(
    teamId: string | undefined,
    event: SlackTeamJoinEvent,
  ): Promise<void> {
    const slackUser = event.user;
    if (!slackUser?.id || slackUser.is_bot || slackUser.deleted) return;

    const resolvedTeamId = teamId ?? slackUser.team_id;
    if (!resolvedTeamId) return;

    const workspace = await this.workspacesService.findBySlackTeamId(resolvedTeamId);
    if (!workspace?.slackBotToken) {
      this.logger.warn(`No workspace/bot token for Slack team ${resolvedTeamId} on team_join`);
      return;
    }

    const name =
      slackUser.profile?.display_name || slackUser.profile?.real_name || slackUser.name || null;
    await this.slackService.deliver(
      workspace.slackBotToken,
      slackUser.id,
      buildWelcomeMessage(name),
    );
  }

  /**
   * We act on app_mentions and direct messages, never on bot-authored posts.
   * Other subtypes are edits, joins and the like, but `file_share` is a person
   * sending a message with an upload — dropping it is what left Gaspo blind to
   * every attachment.
   */
  private isHandledMessage(event: SlackMessageEvent): boolean {
    if (event.bot_id) return false;
    if (event.subtype && event.subtype !== 'file_share') return false;
    if (event.type === 'app_mention') return true;
    return event.type === 'message' && event.channel_type === 'im';
  }

  /** Strip Slack user mentions (e.g. the bot's own `<@U123>`) and trim. */
  private cleanText(text: string): string {
    return text.replace(/<@[^>]+>/g, '').trim();
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId);
    // Bound the set so it doesn't grow unbounded in a long-lived process.
    if (this.seenEventIds.size > 1000) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest) this.seenEventIds.delete(oldest);
    }
  }
}
