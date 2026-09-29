import { XERO_REPORTS } from '../integrations/xero.service';
import type { ToolSpec } from './providers/provider.interface';

/**
 * Xero's financial reports as a local tool, executed by AiService against
 * XeroService. Offered only when Xero is connected. Pipedream's Xero actions
 * cover invoices, contacts and bills but not reports, so this is the only way
 * the model can read a real Profit & Loss rather than reconstructing one.
 */

export const XERO_GET_REPORT = 'xero_get_report';

const XERO_GET_REPORT_TOOL: ToolSpec = {
  name: XERO_GET_REPORT,
  description:
    "Pull an official Xero report exactly as Xero's own Reports screen shows it, in the " +
    "organisation's base currency: ProfitAndLoss (revenue, costs, gross and net profit), " +
    'BalanceSheet, TrialBalance, BankSummary, or ExecutiveSummary. Use it for ANY question about ' +
    'profit, margin, revenue, expenses, or financial position — never add up invoices or bills ' +
    'for those. For a month-by-month view (e.g. trailing 12 months) set from_date/to_date to the ' +
    'LATEST month and ask for periods: 11 with timeframe MONTH; Xero adds the earlier months as ' +
    'columns. Returns the report as text lines, one row per line, cells separated by " | ".',
  parameters: {
    type: 'object',
    properties: {
      report: { type: 'string', enum: [...XERO_REPORTS] },
      from_date: { type: 'string', description: 'Start of the period, YYYY-MM-DD.' },
      to_date: { type: 'string', description: 'End of the period, YYYY-MM-DD.' },
      date: {
        type: 'string',
        description: 'For BalanceSheet, TrialBalance, ExecutiveSummary: the "as at" date.',
      },
      periods: {
        type: 'number',
        description: 'Comparison periods before the main one, 1–11 (11 + the main one = 12).',
      },
      timeframe: { type: 'string', enum: ['MONTH', 'QUARTER', 'YEAR'] },
      organisation: {
        type: 'string',
        description: 'Which Xero organisation, by name, when the login has more than one.',
      },
    },
    required: ['report'],
  },
};

export const XERO_TOOLS: ToolSpec[] = [XERO_GET_REPORT_TOOL];
