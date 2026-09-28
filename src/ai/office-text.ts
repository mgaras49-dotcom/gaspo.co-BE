import { inflateRawSync } from 'zlib';

/**
 * Plain text out of Word, Excel and PowerPoint files, so a document a user
 * attaches in Slack reaches the model as something it can read.
 *
 * The modern Office formats are zip archives of XML, so this is a minimal zip
 * reader over Node's own zlib plus a pass over the XML that matters. There is no
 * npm registry to install a parser from, and the text is all the model needs:
 * formatting, images and formulas are dropped, cell values and paragraphs kept.
 */

/**
 * Most any one archive entry may inflate to. An .xlsx sheet is the largest part
 * in practice; a zip bomb is stopped here rather than exhausting memory.
 */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

/** Text of an Office Open XML document. Throws when the file is not one. */
export function extractOfficeText(kind: OfficeKind, file: Buffer): string {
  const zip = readZip(file);
  if (kind === 'docx') return docxText(zip);
  if (kind === 'xlsx') return xlsxText(zip);
  return pptxText(zip);
}

/** The archive's entries by path, inflated lazily since only a few are read. */
class ZipEntries {
  constructor(
    private readonly file: Buffer,
    private readonly entries: Map<string, { method: number; size: number; offset: number }>,
  ) {}

  names(): string[] {
    return [...this.entries.keys()];
  }

  text(name: string): string | null {
    const entry = this.entries.get(name);
    if (!entry) return null;
    const { file } = this;
    if (entry.offset + 30 > file.length || file.readUInt32LE(entry.offset) !== LOCAL_SIGNATURE) {
      throw new Error(`corrupt zip entry ${name}`);
    }
    // The local header repeats the name and carries its own extra field, whose
    // length can differ from the central directory's copy.
    const start =
      entry.offset +
      30 +
      file.readUInt16LE(entry.offset + 26) +
      file.readUInt16LE(entry.offset + 28);
    const data = file.subarray(start, start + entry.size);
    if (entry.method === 0) return data.toString('utf8');
    if (entry.method === 8) {
      return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
    }
    throw new Error(`unsupported zip compression ${entry.method}`);
  }
}

function readZip(file: Buffer): ZipEntries {
  // The end-of-central-directory record sits in the last 22 bytes, pushed back
  // by an archive comment of up to 64 KB.
  let eocd = -1;
  for (let i = file.length - 22; i >= Math.max(0, file.length - 22 - 0xffff); i--) {
    if (file.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive');

  const count = file.readUInt16LE(eocd + 10);
  let cursor = file.readUInt32LE(eocd + 16);
  const entries = new Map<string, { method: number; size: number; offset: number }>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > file.length || file.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('corrupt zip directory');
    }
    const nameLength = file.readUInt16LE(cursor + 28);
    const name = file.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.set(name, {
      method: file.readUInt16LE(cursor + 10),
      size: file.readUInt32LE(cursor + 20),
      offset: file.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameLength + file.readUInt16LE(cursor + 30) + file.readUInt16LE(cursor + 32);
  }
  return new ZipEntries(file, entries);
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[lower] ?? match;
  });
}

/** Collapse the blank runs tag-stripping leaves behind. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Visible text of a run of WordprocessingML, paragraphs on their own lines. */
function wordRunsText(xml: string): string {
  return decodeXml(
    xml
      // Field codes (a hyperlink's target, a TOC switch) and tracked deletions
      // are text nodes too, but not text anyone reads on the page.
      .replace(/<w:(instrText|delText)\b[^>]*>[\s\S]*?<\/w:\1>/g, '')
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:(br|cr)\b[^>]*\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

function docxText(zip: ZipEntries): string {
  const xml = zip.text('word/document.xml');
  if (xml === null) throw new Error('not a Word document');
  // A table row reads as one line of cells rather than a cell per line, which
  // would leave the model to guess where each row ends.
  const withRows = xml.replace(/<w:tr[\s>][\s\S]*?<\/w:tr>/g, (row) => {
    const cells = row.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) ?? [];
    const line = cells.map((cell) => wordRunsText(cell).replace(/\s+/g, ' ').trim()).join(' | ');
    // Re-escaped because the whole body is decoded again below.
    return `<w:p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:p>`;
  });
  return tidy(wordRunsText(withRows));
}

/** "BC" → 54: a cell reference's column as a zero-based index. */
function columnIndex(ref: string): number {
  let index = 0;
  for (const letter of ref.replace(/[^A-Z]/gi, '').toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function attribute(tag: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

function xlsxText(zip: ZipEntries): string {
  const workbook = zip.text('xl/workbook.xml');
  if (workbook === null) throw new Error('not an Excel workbook');

  const sharedStrings = [
    ...(zip.text('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g),
  ].map(
    // Rich text splits one string across several runs, each with its own <t>.
    ([, si]) =>
      decodeXml([...si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join('')),
  );

  // Sheets are listed by name in the workbook and mapped to their part through
  // its relationships file; the part names themselves are not the tab names.
  const targets = new Map<string, string>();
  for (const [tag] of (zip.text('xl/_rels/workbook.xml.rels') ?? '').matchAll(
    /<Relationship\b[^>]*>/g,
  )) {
    const id = attribute(tag, 'Id');
    const target = attribute(tag, 'Target');
    if (id && target) {
      targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
  }
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)]
    .map(([tag]) => ({
      name: decodeXml(attribute(tag, 'name') ?? 'Sheet'),
      path: targets.get(attribute(tag, 'r:id') ?? '') ?? null,
    }))
    .filter((sheet): sheet is { name: string; path: string } => sheet.path !== null);

  const parts: string[] = [];
  for (const sheet of sheets) {
    const xml = zip.text(sheet.path);
    if (xml === null) continue;
    const lines: string[] = [];
    for (const [, , rowBody] of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (!rowBody) continue;
      const cells: string[] = [];
      for (const [, attrs, cellBody] of rowBody.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attribute(attrs, 't');
        const raw = /<v>([\s\S]*?)<\/v>/.exec(cellBody ?? '')?.[1];
        let value = '';
        if (type === 's') value = sharedStrings[Number(raw)] ?? '';
        else if (type === 'inlineStr') {
          value = decodeXml(
            [...(cellBody ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join(''),
          );
        } else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (raw !== undefined) value = decodeXml(raw);
        const ref = attribute(attrs, 'r');
        const column = ref ? columnIndex(ref) : cells.length;
        while (cells.length < column) cells.push('');
        cells[column] = value.replace(/[\t\n]+/g, ' ');
      }
      if (cells.some((cell) => cell !== '')) lines.push(cells.join('\t'));
    }
    parts.push(`Sheet "${sheet.name}" (tab-separated):\n${lines.join('\n') || '(empty)'}`);
  }
  return parts.join('\n\n');
}

function pptxText(zip: ZipEntries): string {
  const slideNumber = (name: string): number => Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  const slides = zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!slides.length && !zip.text('ppt/presentation.xml')) {
    throw new Error('not a PowerPoint presentation');
  }
  return slides
    .map((name) => {
      const xml = zip.text(name) ?? '';
      const text = decodeXml(
        xml
          .replace(/<a:br\b[^>]*\/>/g, '\n')
          .replace(/<\/a:p>/g, '\n')
          .replace(/<a:t>([\s\S]*?)<\/a:t>|<[^>]+>/g, (_match, t: string | undefined) => t ?? ''),
      );
      return `Slide ${slideNumber(name)}:\n${tidy(text) || '(no text)'}`;
    })
    .join('\n\n');
}
