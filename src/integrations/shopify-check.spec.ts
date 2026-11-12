import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkShopifyConnection,
  shopifyAccountName,
  shopifyHost,
  wrongShopifyToken,
} from './shopify-check';

const unauthorized = Object.assign(
  new Error('Status code: 401\nBody: {"errors":"[API] Invalid API key"}'),
  {
    statusCode: 401,
  },
);

void test('shopifyHost accepts the ways people type a shop ID', () => {
  assert.equal(shopifyHost('alnyra-com'), 'alnyra-com.myshopify.com');
  assert.equal(shopifyHost('caliorra.myshopify.com'), 'caliorra.myshopify.com');
  assert.equal(shopifyHost(' Ensuenza '), 'ensuenza.myshopify.com');
  assert.equal(shopifyHost('https://zyntric-16.myshopify.com/admin'), 'zyntric-16.myshopify.com');
});

void test('wrongShopifyToken names the key people actually pasted', () => {
  // The two shapes found in all 34 of the stores connected on 30 Sept.
  assert.match(wrongShopifyToken('ab2e21' + 'c'.repeat(26)) ?? '', /Client ID/);
  assert.match(wrongShopifyToken('shpss_' + 'a'.repeat(32)) ?? '', /Client secret/);
  assert.match(wrongShopifyToken('hello') ?? '', /not an Admin API access token/);
  assert.equal(wrongShopifyToken('shpat_' + 'a'.repeat(32)), null);
});

void test('a Client ID in the token app is refused without calling Shopify', async () => {
  let called = false;
  const check = await checkShopifyConnection({
    appSlug: 'shopify_developer_app',
    credentials: { shop_id: 'alnyra-com', access_token: 'a71dbc' + '0'.repeat(26) },
    get: async () => {
      called = true;
      return {};
    },
  });
  assert.equal(check.ok, false);
  assert.equal(called, false);
});

void test('a key Shopify rejects fails the connection with the store named', async () => {
  const check = await checkShopifyConnection({
    appSlug: 'shopify_developer_app',
    credentials: { shop_id: 'zyntric-16', access_token: 'shpat_' + 'f'.repeat(32) },
    get: async () => {
      throw unauthorized;
    },
  });
  assert.equal(check.ok, false);
  assert.match(check.ok ? '' : check.message, /zyntric-16\.myshopify\.com \(401\)/);
});

void test('a working store is named after itself', async () => {
  const urls: string[] = [];
  const check = await checkShopifyConnection({
    appSlug: 'shopify',
    credentials: { shop_id: 'alnyra-com' },
    get: async (url) => {
      urls.push(url);
      return { shop: { name: 'Alnyra' } };
    },
  });
  assert.deepEqual(check, { ok: true, name: 'Alnyra', domain: 'alnyra-com.myshopify.com' });
  assert.match(urls[0], /^https:\/\/alnyra-com\.myshopify\.com\/admin\/api\/[\d-]+\/shop\.json$/);
  assert.equal(
    shopifyAccountName(check as { name: string; domain: string }),
    'Alnyra (alnyra-com.myshopify.com)',
  );
});

void test('a passing outage does not block a key that may be fine', async () => {
  const check = await checkShopifyConnection({
    appSlug: 'shopify',
    credentials: { shop_id: 'alnyra-com' },
    get: async () => {
      throw Object.assign(new Error('timeout'), { statusCode: 503 });
    },
  });
  assert.deepEqual(check, { ok: true, name: null, domain: 'alnyra-com.myshopify.com' });
});

void test('an OAuth store without a shop ID is asked by path and named from its answer', async () => {
  // What Pipedream handed back for bolticc on 12 Nov 2026: OAuth material, no shop_id.
  const urls: string[] = [];
  const check = await checkShopifyConnection({
    appSlug: 'shopify',
    credentials: { oauth_access_token: 'shpua_' + 'b'.repeat(32) },
    get: async (url) => {
      urls.push(url);
      return { shop: { name: 'Bolticc', myshopify_domain: 'Bolticc.myshopify.com' } };
    },
  });
  assert.deepEqual(check, { ok: true, name: 'Bolticc', domain: 'bolticc.myshopify.com' });
  assert.match(urls[0], /^\/admin\/api\/[\d-]+\/shop\.json$/);
});

void test('an OAuth store the proxy cannot name still connects, under Pipedream’s label', async () => {
  const check = await checkShopifyConnection({
    appSlug: 'shopify',
    credentials: null,
    get: async () => {
      throw Object.assign(new Error('Status code: 400\nBody: {"error":"bad path"}'), {
        statusCode: 400,
      });
    },
  });
  assert.deepEqual(check, { ok: true, name: null, domain: null });
  assert.equal(shopifyAccountName({ name: null, domain: null }), null);
});

void test('a refused OAuth store is refused even without a shop ID', async () => {
  const check = await checkShopifyConnection({
    appSlug: 'shopify',
    credentials: {},
    get: async () => {
      throw unauthorized;
    },
  });
  assert.equal(check.ok, false);
  assert.match(check.ok ? '' : check.message, /refused this key for the store \(401\)/);
});

void test('a missing shop ID in the token app, or an unknown store, is explained', async () => {
  const missing = await checkShopifyConnection({
    appSlug: 'shopify_developer_app',
    credentials: { access_token: 'shpat_' + 'a'.repeat(32) },
    get: async () => ({}),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? '' : missing.message, /No shop ID came through/);
  const unknown = await checkShopifyConnection({
    appSlug: 'shopify',
    credentials: { shop_id: 'no-such-store' },
    get: async () => {
      throw Object.assign(new Error('Not Found'), { statusCode: 404 });
    },
  });
  assert.match(unknown.ok ? '' : unknown.message, /no store at no-such-store\.myshopify\.com/);
});
