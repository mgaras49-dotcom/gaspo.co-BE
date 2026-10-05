import assert from 'node:assert/strict';
import test from 'node:test';
import { RoutableAction, ToolRouterService } from './tool-router.service';
import {
  LlmProvider,
  ProviderRequest,
  ProviderResponse,
  RemoteMcpServer,
  ToolSpec,
} from './provider.interface';

const SERVERS: RemoteMcpServer[] = [
  { appSlug: 'google_sheets', name: 'google_sheets', url: 'https://mcp/sheets' },
  { appSlug: 'slack', name: 'slack', url: 'https://mcp/slack' },
  { appSlug: 'notion', name: 'notion', url: 'https://mcp/notion' },
];

/** A provider that answers the router with whatever `text` is given. */
function stubProvider(text: string | Error): LlmProvider {
  return {
    id: 'stub',
    isConfigured: () => true,
    create: (): Promise<ProviderResponse> => {
      if (text instanceof Error) return Promise.reject(text);
      return Promise.resolve({
        text,
        toolCalls: [],
        remoteActivity: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end',
        raw: null,
      });
    },
  };
}

async function select(
  answer: string | Error,
  servers: RemoteMcpServer[] = SERVERS,
): Promise<RemoteMcpServer[] | null> {
  return new ToolRouterService().selectRelevantServers(
    stubProvider(answer),
    'claude-sonnet-5',
    'export last week to a spreadsheet',
    servers,
  );
}

void test('selectRelevantServers keeps only the named apps', async () => {
  const selected = await select('["google_sheets"]');
  assert.deepEqual(
    selected?.map((server) => server.appSlug),
    ['google_sheets'],
  );
});

void test('selectRelevantServers preserves input order so the prefix stays cacheable', async () => {
  const selected = await select('["notion", "google_sheets"]');
  assert.deepEqual(
    selected?.map((server) => server.appSlug),
    ['google_sheets', 'notion'],
  );
});

void test('selectRelevantServers trusts an explicit empty answer', async () => {
  assert.deepEqual(await select('[]'), []);
});

void test('selectRelevantServers tolerates a code fence around the array', async () => {
  const selected = await select('```json\n["slack"]\n```');
  assert.deepEqual(
    selected?.map((server) => server.appSlug),
    ['slack'],
  );
});

void test('selectRelevantServers falls back when every name is hallucinated', async () => {
  assert.equal(await select('["salesforce"]'), null);
});

void test('selectRelevantServers falls back on an unparseable answer', async () => {
  assert.equal(await select('I think you should use Google Sheets.'), null);
});

void test('selectRelevantServers falls back when the provider fails', async () => {
  assert.equal(await select(new Error('503')), null);
});

void test('selectRelevantServers skips routing for a single server', async () => {
  assert.equal(await select('["google_sheets"]', SERVERS.slice(0, 1)), null);
});

void test('selectRelevantServers tells the router which tools are built in', async () => {
  // Without this the router cannot tell that a request is already covered
  // locally, and attaches whichever connected app looks topically closest.
  const localTools: ToolSpec[] = [
    { name: 'meta_ads_list_campaigns', description: 'List Meta campaigns', parameters: {} },
    { name: 'verify_roas', description: 'Verify ROAS', parameters: {} },
  ];
  let seen: ProviderRequest | null = null;
  const provider: LlmProvider = {
    id: 'stub',
    isConfigured: () => true,
    create: (request: ProviderRequest): Promise<ProviderResponse> => {
      seen = request;
      return Promise.resolve({
        text: '[]',
        toolCalls: [],
        remoteActivity: [],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end',
        raw: null,
      });
    },
  };

  await new ToolRouterService().selectRelevantServers(
    provider,
    'claude-sonnet-5',
    'what were my top campaigns by spend?',
    SERVERS,
    localTools,
  );

  const sent = (seen as ProviderRequest | null)?.messages[0];
  const content = sent && sent.role === 'user' ? sent.content : '';
  assert.match(content, /meta_ads_list_campaigns/);
  assert.match(content, /verify_roas/);
});

/** Enough actions to clear ACTION_ROUTE_THRESHOLD, with realistic key names. */
const ACTIONS: RoutableAction[] = [
  { name: 'google_ads-list-account-id-options', description: 'List accessible account ids.' },
  { name: 'google_ads-list-campaigns', description: 'List campaigns for a customer.' },
  { name: 'google_ads-create-or-update-campaign', description: 'Create or update a campaign.' },
  { name: 'google_ads-generate-keyword-ideas', description: 'Generate keyword ideas.' },
  { name: 'google_ads-send-offline-conversion', description: 'Upload an offline conversion.' },
];

async function selectActions(
  answer: string | Error,
  actions: RoutableAction[] = ACTIONS,
): Promise<string[] | null> {
  return new ToolRouterService().selectRelevantActions(
    stubProvider(answer),
    'claude-sonnet-5',
    'list my google ads accounts',
    actions,
  );
}

void test('selectRelevantActions keeps only the named actions', async () => {
  const selected = await selectActions('["google_ads-list-campaigns"]');
  assert.deepEqual(selected, ['google_ads-list-campaigns']);
});

void test('selectRelevantActions sorts, so a settled set renders identical bytes', async () => {
  const selected = await selectActions(
    '["google_ads-list-campaigns", "google_ads-list-account-id-options"]',
  );
  assert.deepEqual(selected, ['google_ads-list-account-id-options', 'google_ads-list-campaigns']);
});

void test('selectRelevantActions exposes the app whole when it has few actions', async () => {
  assert.equal(await selectActions('["anything"]', ACTIONS.slice(0, 3)), null);
});

void test('selectRelevantActions exposes the app whole when every name is hallucinated', async () => {
  assert.equal(await selectActions('["google_ads-not-a-real-action"]'), null);
});

void test('selectRelevantActions exposes the app whole when the provider fails', async () => {
  assert.equal(await selectActions(new Error('timeout')), null);
});

void test('selectRelevantActions exposes the app whole on an unparseable answer', async () => {
  assert.equal(await selectActions('I think you want the campaigns one'), null);
});

const STORES: RemoteMcpServer[] = [
  { appSlug: 'gmail', name: 'gmail', url: 'https://mcp/gmail' },
  {
    appSlug: 'shopify',
    name: 'shopify-alnyra',
    url: 'https://mcp/shopify?accountId=apn_1',
    accountLabel: 'Alnyra (alnyra-com.myshopify.com)',
    routeId: 'shopify:alnyra',
  },
  {
    appSlug: 'shopify',
    name: 'shopify-zyntric',
    url: 'https://mcp/shopify?accountId=apn_2',
    accountLabel: 'Zyntric (zyntric-16.myshopify.com)',
    routeId: 'shopify:zyntric',
  },
];

void test('selectRelevantServers can attach one store of an app with several', async () => {
  const selected = await select('["shopify:zyntric"]', STORES);
  assert.deepEqual(
    selected?.map((server) => server.name),
    ['shopify-zyntric'],
  );
});

void test('selectRelevantServers reads a bare app id as every account of it', async () => {
  const selected = await select('["shopify"]', STORES);
  assert.deepEqual(
    selected?.map((server) => server.name),
    ['shopify-alnyra', 'shopify-zyntric'],
  );
});

void test('selectRelevantServers shows the router each account by name', async () => {
  let prompt = '';
  const provider: LlmProvider = {
    ...stubProvider('["gmail"]'),
    create: (request: ProviderRequest) => {
      const first = request.messages[0];
      prompt = 'content' in first ? String(first.content) : '';
      return stubProvider('["gmail"]').create(request);
    },
  };
  await new ToolRouterService().selectRelevantServers(provider, 'm', 'revenue for Zyntric', STORES);
  assert.match(
    prompt,
    /- shopify:zyntric \(shopify — account: Zyntric \(zyntric-16\.myshopify\.com\)\)/,
  );
  assert.match(prompt, /- gmail \(gmail\)/);
});
