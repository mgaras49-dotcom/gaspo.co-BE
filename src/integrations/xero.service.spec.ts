import assert from 'node:assert/strict';
import test from 'node:test';
import { formatXeroReport } from './xero.service';

void test('a Xero P&L flattens to one line per row, figures untouched', () => {
  const text = formatXeroReport({
    ReportTitles: ['Profit and Loss', 'Acme Pty Ltd', '1 August 2026 to 31 August 2026'],
    Rows: [
      { RowType: 'Header', Cells: [{ Value: '' }, { Value: '31 Aug 26' }, { Value: '31 Jul 26' }] },
      {
        RowType: 'Section',
        Title: 'Income',
        Rows: [
          {
            RowType: 'Row',
            Cells: [{ Value: 'Sales' }, { Value: '1200.50' }, { Value: '980.00' }],
          },
          {
            RowType: 'SummaryRow',
            Cells: [{ Value: 'Total Income' }, { Value: '1200.50' }, { Value: '980.00' }],
          },
        ],
      },
      // Xero puts the bottom line in an untitled section.
      {
        RowType: 'Section',
        Title: '',
        Rows: [
          {
            RowType: 'Row',
            Cells: [{ Value: 'Net Profit' }, { Value: '310.25' }, { Value: '-40.00' }],
          },
        ],
      },
      { RowType: 'Section', Title: 'Empty', Rows: [{ RowType: 'Row', Cells: [{ Value: '' }] }] },
    ],
  });

  assert.equal(
    text,
    [
      'Profit and Loss',
      'Acme Pty Ltd',
      '1 August 2026 to 31 August 2026',
      ' | 31 Aug 26 | 31 Jul 26',
      '## Income',
      'Sales | 1200.50 | 980.00',
      'Total Income | 1200.50 | 980.00',
      'Net Profit | 310.25 | -40.00',
      '## Empty',
    ].join('\n'),
  );
});
