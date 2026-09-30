import assert from 'node:assert/strict';
import test from 'node:test';
import { safeFileName } from './generated-files.service';
import { openAiSize } from './image-generation.service';
import { parseBlocks, parseInline, renderPdf, toPdfText } from './pdf-render';

void test('a report renders to a real multi-page PDF', async () => {
  const body = [
    '## Summary',
    'Spend was **$12,400** with ROAS *3.1* → up. See [Ads](https://example.com). 🚀',
    '',
    '- Scale winners',
    '  - nested',
    '1. First',
    '',
    '| Campaign | Spend |',
    '|---|---:|',
    '| Broad | $6,200 |',
    '',
    '---',
    'Lorem ipsum dolor sit amet. '.repeat(400),
  ].join('\n');
  const pdf = await renderPdf({ title: 'Strategy – Q4', subtitle: 'For Acme', body });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/Count [2-9]/);
});

void test('blocks: headings, lists, tables and rules are recognised', () => {
  const blocks = parseBlocks(
    '# Title\n\nText one\ntext two\n\n- a\n- b\n\n| x | y |\n|--|--|\n| 1 | 2 |\n\n***',
  );
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['heading', 'paragraph', 'list', 'table', 'rule'],
  );
  assert.deepEqual(blocks[1], { type: 'paragraph', text: 'Text one text two' });
  assert.deepEqual(blocks[3], { type: 'table', header: ['x', 'y'], rows: [['1', '2']] });
});

void test('a pipe line without a divider row stays text', () => {
  assert.deepEqual(parseBlocks('| not | a table |'), [
    { type: 'paragraph', text: '| not | a table |' },
  ]);
});

void test('inline styles split into spans', () => {
  assert.deepEqual(parseInline('a **b** *c* `d` [e](https://f.io) snake_case_name'), [
    { text: 'a ' },
    { text: 'b', bold: true },
    { text: ' ' },
    { text: 'c', italic: true },
    { text: ' ' },
    { text: 'd', code: true },
    { text: ' ' },
    { text: 'e', link: 'https://f.io' },
    { text: ' snake_case_name' },
  ]);
});

void test('text is reduced to what Helvetica can print', () => {
  assert.equal(toPdfText('ROAS ≥ 3 → scale ✅ 🚀 “ok” – €5'), 'ROAS >= 3 -> scale [x]  “ok” – €5');
});

void test('file names are safe and carry the right extension', () => {
  assert.equal(
    safeFileName('Meta Ads Strategy: Q4/2026.pdf', 'pdf'),
    'Meta Ads Strategy Q4 2026.pdf',
  );
  assert.equal(safeFileName('../../etc/passwd', 'png'), 'etc passwd.png');
  assert.equal(safeFileName('   ', 'pdf'), 'gaspo-file.pdf');
  assert.equal(safeFileName('x'.repeat(200), 'png').length, 84);
});

void test('gpt-image sizes follow the asked-for shape', () => {
  assert.equal(openAiSize('1:1'), '1024x1024');
  assert.equal(openAiSize('5:4'), '1536x1024');
  assert.equal(openAiSize('4:5'), '1024x1536');
  assert.equal(openAiSize('16:9'), '1536x1024');
  assert.equal(openAiSize('9:16'), '1024x1536');
});
