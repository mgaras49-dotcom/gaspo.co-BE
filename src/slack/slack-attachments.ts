import {
  Attachment,
  attachmentSize,
  MAX_ATTACHMENT_BYTES,
  megabytes,
  toAttachment,
} from '../ai/attachments';
import type { RunTurn } from '../ai/ai.service';
import type { MessageAttachmentRef } from '../database/entities';
import type { ConversationTurn } from '../memory/messages.service';
import type { SlackFile } from './interfaces/slack-event.interface';
import type { SlackFileDownload } from './slack.service';

/** Fetches one stored file with the workspace's bot token. */
export type FileDownloader = (ref: MessageAttachmentRef) => Promise<SlackFileDownload>;

/** Attachment bytes still unspent in one run, shared by every turn it replays. */
export interface AttachmentBudget {
  remaining: number;
}

export interface LoadedAttachments {
  attachments: Attachment[];
  /** The refs that became attachments — the ones worth storing for replay. */
  loaded: MessageAttachmentRef[];
  /** "name: reason" for each file that could not be attached. */
  problems: string[];
}

/** A file from a Slack event as a stored reference, or why it cannot be fetched at all. */
export function attachmentRef(
  file: SlackFile,
): { ok: true; ref: MessageAttachmentRef } | { ok: false; problem: string } {
  const name = file.name || file.title || 'a file';
  const refuse = (reason: string) => ({ ok: false as const, problem: `${name}: ${reason}` });
  if (file.mode === 'tombstone') return refuse('it was deleted');
  if (file.mode === 'hidden_by_limit')
    return refuse("it is older than this Slack plan's visible history");
  if (file.mode === 'external') {
    return refuse('it is a link to a file stored outside Slack — upload the file itself instead');
  }
  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    return refuse(
      file.file_access === 'check_file_info'
        ? 'it was shared from another organization over Slack Connect'
        : 'Slack sent no download link for it',
    );
  }
  return {
    ok: true,
    ref: { id: file.id, name, mimetype: file.mimetype ?? null, size: file.size ?? null, url },
  };
}

/** Why a download failed, worded for the model to pass on. */
export function downloadProblem(
  reason: Exclude<SlackFileDownload, { ok: true }>['reason'],
): string {
  switch (reason) {
    case 'no_access':
      return (
        "Gaspo's Slack app does not have permission to read files in this workspace yet — " +
        'a workspace admin needs to add Gaspo to Slack again to grant it'
      );
    case 'too_large':
      return `it is over the ${megabytes(MAX_ATTACHMENT_BYTES)} limit`;
    case 'gone':
      return 'it no longer exists in Slack';
    default:
      return 'downloading it from Slack failed';
  }
}

const OVER_BUDGET = 'the files in this conversation are too large to send together';

/**
 * Fetch stored files and turn them into attachments, spending from the run's
 * shared budget. Anything that cannot be attached comes back as a problem line
 * rather than an error: a bad file should cost the user that file, not the
 * reply.
 */
export async function loadAttachments(
  refs: MessageAttachmentRef[],
  download: FileDownloader,
  budget: AttachmentBudget,
): Promise<LoadedAttachments> {
  const result: LoadedAttachments = { attachments: [], loaded: [], problems: [] };
  for (const ref of refs) {
    const fail = (reason: string) => result.problems.push(`${ref.name}: ${reason}`);
    // Slack reports the size up front, so a file that cannot fit is never fetched.
    if (ref.size !== null && ref.size > MAX_ATTACHMENT_BYTES) {
      fail(downloadProblem('too_large'));
      continue;
    }
    const fetched = await download(ref);
    if (!fetched.ok) {
      fail(downloadProblem(fetched.reason));
      continue;
    }
    const converted = toAttachment(ref, fetched.data);
    if (!converted.ok) {
      fail(converted.reason);
      continue;
    }
    const size = attachmentSize(converted.attachment);
    if (size > budget.remaining) {
      fail(OVER_BUDGET);
      continue;
    }
    budget.remaining -= size;
    result.attachments.push(converted.attachment);
    result.loaded.push(ref);
  }
  return result;
}

/**
 * The prompt as both the model and the thread's memory see it: the user's
 * words, then what came with them. The names matter even though the files ride
 * alongside — an image block carries no name, and a later turn whose file can no
 * longer be fetched still knows one was shared.
 */
export function composePrompt(text: string, attached: string[], problems: string[]): string {
  return [
    text,
    attached.length ? `[Attached: ${attached.join(', ')}]` : '',
    ...problems.map((problem) => `[Could not open ${problem}]`),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Stored history made ready to replay, its files fetched again. The newest
 * turns are served first, so when the budget runs out it is the oldest files
 * that drop, each leaving a note on its turn saying so.
 */
export async function resolveHistory(
  history: ConversationTurn[],
  download: FileDownloader,
  budget: AttachmentBudget,
): Promise<RunTurn[]> {
  const resolved: RunTurn[] = history.map(({ role, content }) => ({ role, content }));
  for (let i = history.length - 1; i >= 0; i--) {
    const refs = history[i].attachments;
    if (!refs?.length) continue;
    const { attachments, problems } = await loadAttachments(refs, download, budget);
    resolved[i] = {
      role: history[i].role,
      content: [
        history[i].content,
        ...problems.map((problem) => `[No longer attached — ${problem}]`),
      ].join('\n\n'),
      ...(attachments.length ? { attachments } : {}),
    };
  }
  return resolved;
}
