import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessageAttachmentRef } from '../database/entities';
import {
  attachmentRef,
  composePrompt,
  FileDownloader,
  loadAttachments,
  resolveHistory,
} from './slack-attachments';

const PDF = Buffer.from('%PDF-1.7\n%%EOF');

function ref(name: string, size: number | null = 100): MessageAttachmentRef {
  return { id: `F_${name}`, name, mimetype: null, size, url: `https://files.slack.com/${name}` };
}

const serves =
  (files: Record<string, Buffer>): FileDownloader =>
  async (r) =>
    files[r.name] ? { ok: true, data: files[r.name] } : { ok: false, reason: 'gone' };

void test('an upload becomes a ref pointing at its download link', () => {
  const result = attachmentRef({
    id: 'F1',
    name: 'deck.pdf',
    mimetype: 'application/pdf',
    size: 10,
    url_private: 'https://files.slack.com/files-pri/T/deck.pdf',
    url_private_download: 'https://files.slack.com/files-pri/T/download/deck.pdf',
  });
  assert.ok(result.ok);
  assert.equal(result.ref.url, 'https://files.slack.com/files-pri/T/download/deck.pdf');
});

void test('files that cannot be downloaded say why before any fetch', () => {
  const deleted = attachmentRef({ id: 'F1', name: 'old.pdf', mode: 'tombstone' });
  const drive = attachmentRef({
    id: 'F2',
    name: 'Plan',
    mode: 'external',
    url_private: 'https://x',
  });
  assert.ok(!deleted.ok && /deleted/.test(deleted.problem));
  assert.ok(!drive.ok && /outside Slack/.test(drive.problem));
});

void test('a missing files:read scope reaches the model as something to act on', async () => {
  const noAccess: FileDownloader = async () => ({ ok: false, reason: 'no_access' });
  const result = await loadAttachments([ref('deck.pdf')], noAccess, { remaining: 1e9 });
  assert.equal(result.attachments.length, 0);
  assert.match(result.problems[0], /^deck\.pdf: .*add Gaspo to Slack again/);
});

void test('an oversized file is refused from its reported size, without downloading', async () => {
  let fetched = 0;
  const counting: FileDownloader = async () => {
    fetched += 1;
    return { ok: true, data: PDF };
  };
  const result = await loadAttachments([ref('huge.pdf', 50 * 1024 * 1024)], counting, {
    remaining: 1e9,
  });
  assert.equal(fetched, 0);
  assert.match(result.problems[0], /over the 10\.0 MB limit/);
});

void test('only files that became attachments are kept for replay', async () => {
  const result = await loadAttachments(
    [ref('deck.pdf'), ref('gone.pdf')],
    serves({ 'deck.pdf': PDF }),
    { remaining: 1e9 },
  );
  assert.deepEqual(
    result.loaded.map((r) => r.name),
    ['deck.pdf'],
  );
  assert.equal(result.problems.length, 1);
});

void test('a file-only message still makes a prompt', () => {
  assert.equal(composePrompt('', ['deck.pdf'], []), '[Attached: deck.pdf]');
  assert.equal(
    composePrompt('summarise', ['a.pdf', 'b.png'], ['c.xls: old format']),
    'summarise\n\n[Attached: a.pdf, b.png]\n\n[Could not open c.xls: old format]',
  );
});

void test('history files are refetched onto their own turn', async () => {
  const history = await resolveHistory(
    [
      {
        role: 'user',
        content: 'read this\n\n[Attached: deck.pdf]',
        attachments: [ref('deck.pdf')],
      },
      { role: 'assistant', content: 'It is a pitch deck.' },
    ],
    serves({ 'deck.pdf': PDF }),
    { remaining: 1e9 },
  );
  assert.equal(history[0].attachments?.[0]?.kind, 'pdf');
  assert.equal(history[1].attachments, undefined);
});

void test('when the budget runs out, the oldest files drop and leave a note', async () => {
  const budget = { remaining: PDF.length };
  const history = await resolveHistory(
    [
      { role: 'user', content: 'first', attachments: [ref('old.pdf')] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second', attachments: [ref('new.pdf')] },
    ],
    serves({ 'old.pdf': PDF, 'new.pdf': PDF }),
    budget,
  );
  assert.equal(history[2].attachments?.length, 1);
  assert.equal(history[0].attachments, undefined);
  assert.match(history[0].content, /\[No longer attached — old\.pdf: .*too large/);
});
