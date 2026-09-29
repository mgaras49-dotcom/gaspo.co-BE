import { Injectable } from '@nestjs/common';
import { PipedreamService } from './pipedream.service';

const XERO_API = 'https://api.xero.com';

/** The reports Gaspo can pull, by their Xero Reports API name. */
export const XERO_REPORTS = [
  'ProfitAndLoss',
  'BalanceSheet',
  'TrialBalance',
  'BankSummary',
  'ExecutiveSummary',
] as const;
export type XeroReportName = (typeof XERO_REPORTS)[number];

/** A connected Xero account, addressed for the Pipedream Connect proxy. */
export interface XeroCredential {
  externalUserId: string;
  accountId: string;
}

/** Report options, passed through to Xero as query parameters. */
export interface XeroReportOptions {
  fromDate?: string;
  toDate?: string;
  /** Balance-sheet style reports are "as at" one date. */
  date?: string;
  /** Extra comparison columns before the main one (Xero allows 1–11). */
  periods?: number;
  timeframe?: 'MONTH' | 'QUARTER' | 'YEAR';
  /** Which organisation, by name, when the login reaches more than one. */
  organisation?: string;
}

interface XeroCell {
  Value?: string;
}
interface XeroRow {
  RowType?: string;
  Title?: string;
  Cells?: XeroCell[];
  Rows?: XeroRow[];
}
interface XeroReport {
  ReportName?: string;
  ReportTitles?: string[];
  Rows?: XeroRow[];
}
interface XeroConnection {
  tenantId: string;
  tenantName?: string;
  tenantType?: string;
}

/**
 * Flatten a Xero report into compact text: its titles, then one line per row
 * with cells separated by " | ", and "## " before each section. The JSON Xero
 * returns is mostly nesting and attributes; this keeps a 12-month P&L to a few
 * thousand tokens and leaves every figure exactly as Xero computed it.
 */
export function formatXeroReport(report: XeroReport): string {
  const lines: string[] = [...(report.ReportTitles ?? [])];
  const cells = (row: XeroRow) => (row.Cells ?? []).map((cell) => cell.Value ?? '').join(' | ');
  const walk = (rows: XeroRow[] | undefined) => {
    for (const row of rows ?? []) {
      if (row.RowType === 'Section') {
        if (row.Title) lines.push(`## ${row.Title}`);
        walk(row.Rows);
      } else if (row.Cells?.length) {
        const line = cells(row);
        if (line.replace(/[\s|]/g, '')) lines.push(line);
      }
    }
  };
  walk(report.Rows);
  return lines.join('\n');
}

/**
 * Reads Xero's financial reports — Profit & Loss, Balance Sheet and the like —
 * which Pipedream's Xero actions do not cover. Without this the model tried the
 * generic "make an API call" action, got a 404, and rebuilt "profit" by adding
 * up raw invoices in three currencies, which is how a business was told it had
 * made $9.69M. Reports come back in the organisation's base currency, already
 * netted the way the accountant sees them.
 *
 * Calls go through the Pipedream Connect proxy, so no Xero token is held here.
 */
@Injectable()
export class XeroService {
  constructor(private readonly pipedream: PipedreamService) {}

  /** Pull one report and return it as text headed by the organisation it is for. */
  async getReport(
    credential: XeroCredential,
    report: XeroReportName,
    options: XeroReportOptions = {},
  ): Promise<string> {
    const tenant = await this.tenantFor(credential, options.organisation);
    const organisation = await this.get<{
      Organisations?: Array<{ Name?: string; BaseCurrency?: string }>;
    }>(credential, '/api.xro/2.0/Organisation', tenant.tenantId);
    const org = organisation.Organisations?.[0];

    const params: Record<string, string> = {};
    if (options.fromDate) params.fromDate = options.fromDate;
    if (options.toDate) params.toDate = options.toDate;
    if (options.date) params.date = options.date;
    if (options.periods) params.periods = String(Math.min(11, Math.max(1, options.periods)));
    if (options.timeframe) params.timeframe = options.timeframe;

    const response = await this.get<{ Reports?: XeroReport[] }>(
      credential,
      `/api.xro/2.0/Reports/${report}`,
      tenant.tenantId,
      params,
    );
    const body = response.Reports?.[0];
    if (!body) throw new Error(`Xero returned no ${report} report`);

    return [
      `Organisation: ${org?.Name ?? tenant.tenantName ?? tenant.tenantId}`,
      `Base currency: ${org?.BaseCurrency ?? 'unknown'} (all amounts below are in it)`,
      formatXeroReport(body),
    ].join('\n');
  }

  /**
   * The Xero organisation to read. A login can reach several; the named one
   * wins, else the only one. Several and none named is an error that lists
   * them, so the model can ask which the user meant rather than guess.
   */
  private async tenantFor(credential: XeroCredential, name?: string): Promise<XeroConnection> {
    const connections = (
      await this.pipedream.proxyRequest<XeroConnection[]>(credential, {
        url: `${XERO_API}/connections`,
        headers: { Accept: 'application/json' },
      })
    ).filter((connection) => (connection.tenantType ?? 'ORGANISATION') === 'ORGANISATION');
    if (!connections.length) throw new Error('This Xero login has no organisations connected');
    if (name) {
      const wanted = name.trim().toLowerCase();
      const match = connections.find((c) => c.tenantName?.toLowerCase().includes(wanted));
      if (match) return match;
    }
    if (connections.length === 1) return connections[0];
    throw new Error(
      `This Xero login reaches ${connections.length} organisations: ${connections
        .map((c) => c.tenantName ?? c.tenantId)
        .join(', ')}. Say which one with the organisation parameter.`,
    );
  }

  private get<T>(
    credential: XeroCredential,
    path: string,
    tenantId: string,
    params?: Record<string, string>,
  ): Promise<T> {
    return this.pipedream.proxyRequest<T>(credential, {
      url: `${XERO_API}${path}`,
      params,
      headers: { 'xero-tenant-id': tenantId, Accept: 'application/json' },
    });
  }
}
