import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateRawSync } from 'zlib';
import { toAttachment } from './attachments';

/** A minimal zip writer, enough to build Office files from XML in a test. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function textOf(result: ReturnType<typeof toAttachment>): string {
  assert.ok(result.ok, result.ok ? '' : result.reason);
  assert.equal(result.attachment.kind, 'text');
  return result.attachment.kind === 'text' ? result.attachment.text : '';
}

void test('a PDF goes over as the file itself', () => {
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
  const result = toAttachment({ name: 'deck.pdf', mimetype: 'application/pdf' }, pdf);
  assert.ok(result.ok);
  assert.equal(result.attachment.kind, 'pdf');
});

void test('an image is typed from its bytes, not its label', () => {
  // Anthropic rejects an image whose declared type does not match, and fails
  // the whole request with it, so a PNG labelled JPEG must go over as a PNG.
  const png = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(16)]);
  const result = toAttachment({ name: 'shot.jpg', mimetype: 'image/jpeg' }, png);
  assert.ok(result.ok);
  assert.equal(result.attachment.kind === 'image' && result.attachment.mediaType, 'image/png');
});

void test('a file claiming to be a PDF that is not one is refused, not sent', () => {
  const result = toAttachment(
    { name: 'broken.pdf', mimetype: 'application/pdf' },
    Buffer.from('<html>login</html>'),
  );
  assert.equal(result.ok, false);
});

void test('an unsupported image format says what to send instead', () => {
  const result = toAttachment(
    { name: 'IMG_0001.heic', mimetype: 'image/heic' },
    Buffer.alloc(64, 1),
  );
  assert.ok(!result.ok && /PNG or JPEG/.test(result.reason));
});

void test('CSV and code are read as text', () => {
  assert.equal(
    textOf(toAttachment({ name: 'leads.csv', mimetype: 'text/csv' }, Buffer.from('a,b\n1,2\n'))),
    'a,b\n1,2',
  );
  // Slack often labels code as a generic binary type; the extension decides.
  assert.match(
    textOf(
      toAttachment(
        { name: 'job.py', mimetype: 'application/octet-stream' },
        Buffer.from('print(1)'),
      ),
    ),
    /print/,
  );
});

void test('binary content behind a text extension is refused', () => {
  const result = toAttachment(
    { name: 'data.txt', mimetype: 'text/plain' },
    Buffer.from([0x41, 0x00, 0x42]),
  );
  assert.equal(result.ok, false);
});

void test('a long text file is cut, and says so', () => {
  const text = textOf(
    toAttachment({ name: 'big.txt', mimetype: 'text/plain' }, Buffer.from('x'.repeat(200_000))),
  );
  assert.ok(text.length < 200_000);
  assert.match(text, /Truncated/);
});

void test('a Word document reads as paragraphs, with table rows kept together', () => {
  const docx = zip({
    'word/document.xml':
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Q3 plan</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Budget &amp; </w:t></w:r><w:r><w:t>targets</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Channel</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Spend</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>Meta</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>R&amp;D &lt;5k</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '<w:p><w:r><w:instrText>HYPERLINK "x"</w:instrText><w:t>End</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  });
  const text = textOf(toAttachment({ name: 'plan.docx', mimetype: null }, docx));
  assert.equal(text, 'Q3 plan\nBudget & targets\nChannel | Spend\nMeta | R&D <5k\nEnd');
});

void test('an Excel workbook reads as named, tab-separated sheets', () => {
  const xlsx = zip({
    'xl/workbook.xml':
      '<workbook><sheets><sheet name="Leads" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':
      '<sst><si><t>Name</t></si><si><t>Deal</t></si><si><r><t>Acme </t></r><r><t>Ltd</t></r></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"/>' +
      '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" s="1"/><c r="C3"><f>1+1</f><v>2</v></c></row>' +
      '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':
      '<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>skip A</t></is></c></row></sheetData></worksheet>',
  });
  const text = textOf(toAttachment({ name: 'pipeline.xlsx', mimetype: null }, xlsx));
  assert.equal(
    text,
    'Sheet "Leads" (tab-separated):\nName\tDeal\nAcme Ltd\t\t2\n\nSheet "Notes" (tab-separated):\n\tskip A',
  );
});

void test('a PowerPoint deck reads slide by slide, in slide order', () => {
  const pptx = zip({
    'ppt/presentation.xml': '<p:presentation/>',
    'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Ten</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml':
      '<p:sld><a:p><a:r><a:t>Two</a:t></a:r><a:br/><a:r><a:t>lines</a:t></a:r></a:p></p:sld>',
  });
  const text = textOf(toAttachment({ name: 'pitch.pptx', mimetype: null }, pptx));
  assert.equal(text, 'Slide 2:\nTwo\nlines\n\nSlide 10:\nTen');
});

void test('a damaged Office file is refused with a reason, not thrown', () => {
  const result = toAttachment(
    { name: 'plan.docx', mimetype: null },
    Buffer.from('not a zip at all, sorry'),
  );
  assert.ok(!result.ok && /damaged/.test(result.reason));
});

void test('old binary Office formats point to the modern one', () => {
  const result = toAttachment(
    { name: 'budget.xls', mimetype: 'application/vnd.ms-excel' },
    Buffer.alloc(64, 1),
  );
  assert.ok(!result.ok && /\.xlsx/.test(result.reason));
});
