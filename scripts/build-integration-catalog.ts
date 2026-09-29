/**
 * Snapshot the Pipedream app catalogue into a static file the dashboard ships
 * with, so the Integrations tab renders from local data instead of paying a
 * Pipedream round-trip (~3s per page) for the first paint, every scroll page
 * and every search.
 *
 *   npm run catalog:build [outputPath]
 *
 * Writes into the frontend repo, which lives beside this one by default. The
 * order is Pipedream's own `featured_weight` ranking, which the UI relies on to
 * fill its "Popular" section, so it is preserved verbatim.
 *
 * Re-run whenever the catalogue should catch up with Pipedream; the UI still
 * falls back to the live search endpoint for apps missing from the snapshot,
 * so a stale file degrades search latency, never correctness.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PipedreamClient, ProjectEnvironment } from '@pipedream/sdk';

const DEFAULT_OUTPUT = '../gomer.ai-FE/src/data/integrations-catalog.json';

/** Pipedream's page cap for `apps.list`; fewer pages, fewer round-trips. */
const PAGE_SIZE = 100;

/**
 * Every catalogue icon is served from this template, keyed by the app id, so
 * the snapshot stores the id (~11 bytes) rather than the URL (~60). Apps whose
 * icon sits elsewhere keep their full URL — the reader tells them apart by the
 * `https://` prefix. Keep in sync with the frontend's `integration-catalog.ts`.
 */
const iconTemplate = (appId: string) => `https://assets.pipedream.net/s.v0/${appId}/logo/orig`;

/**
 * Apps left out of the snapshot. Shopify Partner reads Shopify's developer
 * programme, not a store, and sat beside the two store connectors looking like
 * a third way to connect a shop.
 */
const HIDDEN_SLUGS = new Set(['shopify_partner']);

/** `[name, nameSlug, appId | full icon URL]` — positional to keep the file small. */
type CatalogEntry = [string, string, string];

function buildClient(): PipedreamClient {
  const { PIPEDREAM_CLIENT_ID, PIPEDREAM_CLIENT_SECRET, PIPEDREAM_PROJECT_ID } = process.env;
  if (!PIPEDREAM_CLIENT_ID || !PIPEDREAM_CLIENT_SECRET || !PIPEDREAM_PROJECT_ID) {
    throw new Error('PIPEDREAM_CLIENT_ID/SECRET/PROJECT_ID must be set to build the catalogue');
  }
  return new PipedreamClient({
    clientId: PIPEDREAM_CLIENT_ID,
    clientSecret: PIPEDREAM_CLIENT_SECRET,
    projectId: PIPEDREAM_PROJECT_ID,
    projectEnvironment: (process.env.PIPEDREAM_ENVIRONMENT ?? 'production') as ProjectEnvironment,
  });
}

async function main(): Promise<void> {
  const output = resolve(process.cwd(), process.argv[2] ?? DEFAULT_OUTPUT);
  const client = buildClient();

  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  let pages = 0;

  do {
    const page = await client.apps.list(
      {
        after,
        limit: PAGE_SIZE,
        sortKey: 'featured_weight',
        sortDirection: 'desc',
      },
      { timeoutInSeconds: 30 },
    );
    for (const app of page.data) {
      // A slug is what every downstream lookup keys on (connect, configure
      // routes, connected-account grouping), so skip anything without one.
      if (!app.id || !app.nameSlug || seen.has(app.nameSlug) || HIDDEN_SLUGS.has(app.nameSlug)) {
        continue;
      }
      seen.add(app.nameSlug);
      const expected = iconTemplate(app.id);
      // Pipedream's names can carry stray whitespace ("Shopify "), which shows
      // up in the dashboard and breaks exact-name lookups.
      entries.push([
        app.name.trim(),
        app.nameSlug,
        app.imgSrc === expected ? app.id : (app.imgSrc ?? ''),
      ]);
    }
    after = page.hasNextPage() ? page.response.pageInfo?.endCursor : undefined;
    pages += 1;
    process.stdout.write(`\rpage ${pages} — ${entries.length} apps`);
  } while (after);

  const file = {
    generatedAt: new Date().toISOString(),
    count: entries.length,
    apps: entries,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(file)}\n`);
  console.log(`\nwrote ${entries.length} apps to ${output}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
