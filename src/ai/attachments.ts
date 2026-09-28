import { extname } from 'path';
import { extractOfficeText, OfficeKind } from './office-text';

/**
 * A file a user attached to their message, in a form a provider can hand to the
 * model. PDFs and images go over as the file itself — Claude reads both natively,
 * scans, charts and layout included — while everything textual (plain text, CSV,
 * code, and the text pulled out of Word, Excel and PowerPoint files) goes over
 * as text, which every model can read.
 */
export type Attachment =
  | { kind: 'pdf'; name: string; data: string }
  | { kind: 'image'; name: string; mediaType: ImageMediaType; data: string }
  | { kind: 'text'; name: string; text: string };

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

/** Largest file we download at all. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Most attachment payload one run carries, across the new message and the
 * earlier turns whose files are resent. Anthropic caps a request at 32 MB and
 * base64 adds a third, so this leaves room for the rest of the prompt.
 */
export const MAX_RUN_ATTACHMENT_BYTES = 18 * 1024 * 1024;

/** Anthropic rejects an image over 5 MB, and with it the whole request. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Text kept from one file, about 40K tokens. A long export is cut rather than
 * dropped: the top of a CSV answers most questions asked about it.
 */
const MAX_TEXT_CHARS = 150_000;

/** Extensions read as UTF-8 text, for when the mimetype is generic or missing. */
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'html',
  'htm',
  'log',
  'ini',
  'toml',
  'sql',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rb',
  'go',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cpp',
  'cs',
  'php',
  'sh',
  'css',
  'scss',
  'vtt',
  'srt',
  'rtf',
  'eml',
]);

const TEXT_MIMETYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
  'application/sql',
  'application/x-sh',
  'application/csv',
  'application/rtf',
]);

const OFFICE_EXTENSIONS: Record<string, OfficeKind> = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

/** Old binary Office formats we cannot read, and what to ask for instead. */
const LEGACY_OFFICE: Record<string, string> = {
  doc: 'an older Word format (.doc) — ask for .docx or PDF',
  xls: 'an older Excel format (.xls) — ask for .xlsx or CSV',
  ppt: 'an older PowerPoint format (.ppt) — ask for .pptx or PDF',
};

export type AttachmentResult = { ok: true; attachment: Attachment } | { ok: false; reason: string };

/**
 * Turn a downloaded file into an {@link Attachment}, or say why it cannot be one.
 *
 * The type is taken from the bytes where it matters: a PDF or image the model
 * rejects fails the entire request, not just that file, so a mislabelled or
 * truncated one is caught here instead.
 */
export function toAttachment(
  file: { name: string; mimetype?: string | null },
  bytes: Buffer,
): AttachmentResult {
  const name = file.name;
  const mimetype = (file.mimetype ?? '').toLowerCase();
  const extension = extname(name).slice(1).toLowerCase();

  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { ok: true, attachment: { kind: 'pdf', name, data: bytes.toString('base64') } };
  }
  const imageType = sniffImage(bytes);
  if (imageType) {
    if (bytes.length > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: `the image is over 5 MB (${megabytes(bytes.length)}) — ask for a smaller one`,
      };
    }
    return {
      ok: true,
      attachment: { kind: 'image', name, mediaType: imageType, data: bytes.toString('base64') },
    };
  }
  if (mimetype === 'application/pdf' || extension === 'pdf') {
    return { ok: false, reason: 'the PDF is damaged or not really a PDF' };
  }
  if (mimetype.startsWith('image/')) {
    return {
      ok: false,
      reason: `${mimetype.slice(6).toUpperCase()} images are not supported — ask for PNG or JPEG`,
    };
  }

  const office = OFFICE_EXTENSIONS[extension];
  if (office) {
    try {
      return textAttachment(name, extractOfficeText(office, bytes));
    } catch {
      return {
        ok: false,
        reason: `the file could not be read as .${extension} (it may be damaged or password-protected)`,
      };
    }
  }
  if (LEGACY_OFFICE[extension]) return { ok: false, reason: `it is ${LEGACY_OFFICE[extension]}` };

  if (
    mimetype.startsWith('text/') ||
    TEXT_MIMETYPES.has(mimetype) ||
    TEXT_EXTENSIONS.has(extension)
  ) {
    // A NUL byte means binary content behind a text-looking name.
    if (bytes.subarray(0, 8192).includes(0)) {
      return { ok: false, reason: 'the file is binary, not text' };
    }
    return textAttachment(name, bytes.toString('utf8'));
  }

  return {
    ok: false,
    reason: `${extension ? `.${extension} files` : 'this file type'} cannot be read yet — PDFs, images, Word, Excel, PowerPoint, CSV and text files can`,
  };
}

function textAttachment(name: string, raw: string): AttachmentResult {
  const text = raw.trim();
  if (!text) {
    return {
      ok: false,
      reason: 'it has no readable text (it may be scanned images — a PDF of it would work)',
    };
  }
  return {
    ok: true,
    attachment: {
      kind: 'text',
      name,
      text:
        text.length > MAX_TEXT_CHARS
          ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Truncated: only the first ${MAX_TEXT_CHARS.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters are included.]`
          : text,
    },
  };
}

/** What an attachment adds to the request, for the per-run budget. */
export function attachmentSize(attachment: Attachment): number {
  return attachment.kind === 'text'
    ? attachment.text.length
    : Buffer.byteLength(attachment.data, 'base64');
}

/** How a text attachment is laid out wherever it has to travel as plain text. */
export function attachmentAsText(attachment: Extract<Attachment, { kind: 'text' }>): string {
  return `<attached_file name="${attachment.name}">\n${attachment.text}\n</attached_file>`;
}

export function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sniffImage(bytes: Buffer): ImageMediaType | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}
