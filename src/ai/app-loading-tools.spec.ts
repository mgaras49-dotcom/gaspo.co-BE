import assert from 'node:assert/strict';
import test from 'node:test';
import { matchAppServers } from './app-loading-tools';
import type { RemoteMcpServer } from './providers/provider.interface';

const server = (appSlug: string, scope = 'ws'): RemoteMcpServer => ({
  appSlug,
  name: `pipedream-${scope}-${appSlug}`,
  url: `https://example.test/${scope}/${appSlug}`,
});

const servers = [
  server('gmail'),
  server('gmail', 'u_1'),
  server('google_ads'),
  server('google_sheets'),
  server('shopify_developer_app'),
];
const names = new Map([
  ['gmail', 'Gmail'],
  ['google_ads', 'Google Ads'],
  ['google_sheets', 'Google Sheets'],
  ['shopify_developer_app', 'Shopify (Key Required)'],
]);

test('matchAppServers finds an app by its name or its id, in any spelling', () => {
  for (const reference of ['Google Ads', 'google_ads', 'google-ads', 'GOOGLE ADS']) {
    assert.deepEqual(
      matchAppServers(reference, servers, names).map((s) => s.appSlug),
      ['google_ads'],
      reference,
    );
  }
});

test('matchAppServers returns every account of the app, team and private', () => {
  assert.deepEqual(
    matchAppServers('Gmail', servers, names).map((s) => s.name),
    ['pipedream-ws-gmail', 'pipedream-u_1-gmail'],
  );
});

test('matchAppServers falls back to a partial match only when nothing matches exactly', () => {
  assert.deepEqual(
    matchAppServers('Shopify', servers, names).map((s) => s.appSlug),
    ['shopify_developer_app'],
  );
  // "Google" is part of two apps' names and matches both rather than guessing one.
  assert.deepEqual(
    matchAppServers('Google', servers, names).map((s) => s.appSlug),
    ['google_ads', 'google_sheets'],
  );
});

test('matchAppServers matches nothing for an app that is not connected', () => {
  assert.deepEqual(matchAppServers('YouTube', servers, names), []);
  assert.deepEqual(matchAppServers('  ', servers, names), []);
});

const stores: RemoteMcpServer[] = [
  {
    ...server('shopify'),
    name: 'shopify-alnyra',
    accountLabel: 'Alnyra (alnyra-com.myshopify.com)',
  },
  {
    ...server('shopify'),
    name: 'shopify-zyntric',
    accountLabel: 'Zyntric (zyntric-16.myshopify.com)',
  },
];

test('matchAppServers narrows to the named account of an app with several', () => {
  assert.deepEqual(
    matchAppServers('Shopify', stores, new Map([['shopify', 'Shopify']]), 'zyntric').map(
      (s) => s.name,
    ),
    ['shopify-zyntric'],
  );
  assert.equal(matchAppServers('Shopify', stores, new Map(), undefined).length, 2);
  assert.deepEqual(matchAppServers('Shopify', stores, new Map(), 'Playllo'), []);
});
