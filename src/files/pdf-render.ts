import PDFDocument from 'pdfkit';

/**
 * Turn Markdown-ish text into a clean, printable PDF: headings, paragraphs,
 * bullet and numbered lists, tables, rules, and inline bold, italic, code and
 * links. It is the subset a model writes when asked for a report, not a full
 * Markdown engine; anything else prints as the plain text it is.
 *
 * Uses PDFKit's built-in Helvetica, which only covers the Windows-1252
 * character set. {@link toPdfText} maps what it can (arrows, check marks) and
 * drops the rest, such as emoji, rather than printing them as garbage.
 */

const MARGIN = 56;
const BODY_SIZE = 10.5;
const LINE_GAP = 3;
const INK = '#111111';
const MUTED = '#666666';
const RULE = '#d0d0d0';
const TABLE_HEAD_FILL = '#f2f2f2';
const CELL_PAD = 5;

const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 15, 3: 12.5, 4: 11 };

/** Characters Helvetica lacks, mapped to ones it has. */
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[✓✔✅☑]/g, '[x]'],
  [/[✗✘❌☐⬜]/g, '[ ]'],
  [/→|⟶|➔|➜/g, '->'],
  [/←/g, '<-'],
  [/≥/g, '>='],
  [/≤/g, '<='],
  [/≈/g, '~'],
  [/≠/g, '!='],
  [/[\u2010\u2011\u2012]/g, '-'],
  [/[\u00a0\u2009\u202f]/g, ' '],
];

/** Every character Windows-1252 (and so Helvetica) can print. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

export function toPdfText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of REPLACEMENTS) out = out.replace(pattern, replacement);
  return [...out]
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return (
        ch === '\n' ||
        (code >= 0x20 && code <= 0x7e) ||
        (code >= 0xa0 && code <= 0xff) ||
        WIN_ANSI_EXTRA.has(ch)
      );
    })
    .join('');
}

/** A run of text with one style. */
export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

/** Split a line into styled spans: **bold**, *italic* / _italic_, `code`, [text](url). */
export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  const pattern =
    /\*\*(.+?)\*\*|__(.+?)__|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ text: text.slice(last, index) });
    if (match[1] !== undefined || match[2] !== undefined) {
      spans.push({ text: match[1] ?? match[2], bold: true });
    } else if (match[3] !== undefined) {
      spans.push({ text: match[3], code: true });
    } else if (match[4] !== undefined) {
      spans.push({ text: match[4], link: match[5] });
    } else {
      spans.push({ text: match[6] ?? match[7], italic: true });
    }
    last = index + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans.filter((span) => span.text.length > 0);
}

/** One block of the document. */
export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | {
      type: 'list';
      ordered: boolean;
      items: Array<{ text: string; depth: number; marker: string }>;
    }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'rule' };

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Split Markdown-ish text into blocks. */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: Math.min(heading[1].length, 4), text: heading[2] });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i += 1;
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const items: Array<{ text: string; depth: number; marker: string }> = [];
      while (i < lines.length) {
        const next = LIST_ITEM.exec(lines[i]);
        if (next) {
          items.push({
            text: next[3],
            depth: Math.min(Math.floor(next[1].replace(/\t/g, '  ').length / 2), 3),
            marker: /\d/.test(next[2]) ? next[2].replace(')', '.') : '•',
          });
          i += 1;
        } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && items.length) {
          // A wrapped continuation of the item above.
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i += 1;
        } else {
          break;
        }
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !LIST_ITEM.test(lines[i]) &&
      !TABLE_ROW.test(lines[i])
    ) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    if (paragraph.length) {
      blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    } else {
      // A stray table-looking line with no divider: print it as text.
      blocks.push({ type: 'paragraph', text: line.trim() });
      i += 1;
    }
  }
  return blocks;
}

function fontFor(span: Span, baseBold = false): string {
  if (span.code) return 'Courier';
  const bold = baseBold || span.bold;
  if (bold && span.italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (span.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/** Plain text of a line, markers removed, for measuring. */
function plain(text: string): string {
  return parseInline(text)
    .map((span) => span.text)
    .join('');
}

/**
 * Write styled spans as one flowing paragraph. PDFKit carries the position
 * across `continued` calls, so each span can switch font mid-line.
 */
function writeSpans(
  doc: PDFKit.PDFDocument,
  spans: Span[],
  options: { x: number; width: number; size: number; bold?: boolean; color?: string },
): void {
  const parts = spans.length ? spans : [{ text: ' ' }];
  parts.forEach((span, index) => {
    const last = index === parts.length - 1;
    doc
      .font(fontFor(span, options.bold))
      .fontSize(span.code ? options.size - 0.5 : options.size)
      .fillColor(span.link ? '#1a56db' : (options.color ?? INK));
    const textOptions: PDFKit.Mixins.TextOptions = {
      continued: !last,
      lineGap: LINE_GAP,
      link: span.link ?? null,
      underline: Boolean(span.link),
    };
    if (index === 0)
      doc.text(toPdfText(span.text), options.x, doc.y, { ...textOptions, width: options.width });
    else doc.text(toPdfText(span.text), textOptions);
  });
  doc.fillColor(INK);
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  if (doc.y + height > doc.page.height - MARGIN) doc.addPage();
}

function drawTable(doc: PDFKit.PDFDocument, header: string[], rows: string[][]): void {
  const columns = Math.max(header.length, ...rows.map((row) => row.length));
  const left = MARGIN;
  const width = doc.page.width - MARGIN * 2;
  // Share the width by how much text each column holds, within limits, so a
  // name column is not squeezed to the width of a number column.
  const lengths = Array.from({ length: columns }, (_, c) =>
    Math.max(4, ...[header, ...rows].map((row) => plain(row[c] ?? '').length)),
  );
  const capped = lengths.map((length) => Math.min(length, 40));
  const total = capped.reduce((sum, value) => sum + value, 0);
  const widths = capped.map((value) => Math.max(40, (value / total) * width));
  const scale = width / widths.reduce((sum, value) => sum + value, 0);
  for (let c = 0; c < widths.length; c += 1) widths[c] *= scale;
  const size = BODY_SIZE - 1;

  const rowHeight = (cells: string[], bold: boolean): number =>
    Math.max(
      ...widths.map((w, c) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
        return doc.heightOfString(toPdfText(plain(cells[c] ?? '')) || ' ', {
          width: w - CELL_PAD * 2,
          lineGap: 1,
        });
      }),
    ) +
    CELL_PAD * 2;

  const drawRow = (cells: string[], bold: boolean): void => {
    const height = rowHeight(cells, bold);
    if (doc.y + height > doc.page.height - MARGIN) {
      doc.addPage();
      if (!bold) drawRow(header, true);
    }
    const top = doc.y;
    if (bold) doc.rect(left, top, width, height).fill(TABLE_HEAD_FILL);
    let x = left;
    widths.forEach((w, c) => {
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(size)
        .fillColor(INK)
        .text(toPdfText(plain(cells[c] ?? '')), x + CELL_PAD, top + CELL_PAD, {
          width: w - CELL_PAD * 2,
          lineGap: 1,
        });
      x += w;
    });
    doc
      .moveTo(left, top + height)
      .lineTo(left + width, top + height)
      .lineWidth(0.5)
      .strokeColor(RULE)
      .stroke();
    doc.x = left;
    doc.y = top + height;
  };

  drawRow(header, true);
  for (const row of rows) drawRow(row, false);
  doc.y += 10;
}

/** Render a titled document to PDF bytes. */
export function renderPdf(input: {
  title: string;
  subtitle?: string;
  body: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      info: { Title: toPdfText(input.title), Creator: 'Gaspo' },
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const width = doc.page.width - MARGIN * 2;
      doc
        .font('Helvetica-Bold')
        .fontSize(24)
        .fillColor(INK)
        .text(toPdfText(input.title), { width });
      if (input.subtitle) {
        doc.moveDown(0.2);
        doc
          .font('Helvetica')
          .fontSize(11)
          .fillColor(MUTED)
          .text(toPdfText(input.subtitle), { width });
      }
      doc.moveDown(0.4);
      doc
        .moveTo(MARGIN, doc.y)
        .lineTo(MARGIN + width, doc.y)
        .lineWidth(1)
        .strokeColor(INK)
        .stroke();
      doc.moveDown(1);

      for (const block of parseBlocks(input.body)) {
        doc.x = MARGIN;
        if (block.type === 'heading') {
          const size = HEADING_SIZES[block.level] ?? BODY_SIZE;
          ensureSpace(doc, size * 3);
          doc.moveDown(block.level <= 2 ? 0.6 : 0.3);
          writeSpans(doc, parseInline(block.text), { x: MARGIN, width, size, bold: true });
          doc.moveDown(0.35);
        } else if (block.type === 'paragraph') {
          ensureSpace(doc, BODY_SIZE * 2);
          writeSpans(doc, parseInline(block.text), { x: MARGIN, width, size: BODY_SIZE });
          doc.moveDown(0.6);
        } else if (block.type === 'list') {
          for (const item of block.items) {
            ensureSpace(doc, BODY_SIZE * 2);
            const indent = MARGIN + item.depth * 16;
            const top = doc.y;
            doc
              .font('Helvetica')
              .fontSize(BODY_SIZE)
              .fillColor(INK)
              .text(item.marker, indent, top, {
                width: 16,
                lineGap: LINE_GAP,
              });
            doc.y = top;
            writeSpans(doc, parseInline(item.text), {
              x: indent + (item.marker === '•' ? 11 : 16),
              width: width - (indent - MARGIN) - 16,
              size: BODY_SIZE,
            });
            doc.moveDown(0.2);
          }
          doc.moveDown(0.5);
        } else if (block.type === 'table') {
          ensureSpace(doc, 60);
          drawTable(doc, block.header, block.rows);
        } else {
          doc.moveDown(0.3);
          doc
            .moveTo(MARGIN, doc.y)
            .lineTo(MARGIN + width, doc.y)
            .lineWidth(0.5)
            .strokeColor(RULE)
            .stroke();
          doc.moveDown(0.8);
        }
      }

      // Page numbers, once every page exists.
      const range = doc.bufferedPageRange();
      for (let page = range.start; page < range.start + range.count; page += 1) {
        doc.switchToPage(page);
        const bottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc
          .font('Helvetica')
          .fontSize(8)
          .fillColor(MUTED)
          .text(`${page + 1} / ${range.count}`, MARGIN, doc.page.height - MARGIN / 2 - 4, {
            width,
            align: 'right',
            lineBreak: false,
          });
        doc.page.margins.bottom = bottom;
      }
      doc.end();
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
