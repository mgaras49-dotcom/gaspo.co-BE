/**
 * Checking a Shopify connection before we call it connected.
 *
 * Pipedream stores whatever is typed into its Shopify form; it never asks
 * Shopify. On 30 Sept 2026 Dreka connected 34 stores this way and Gaspo said
 * "✅ connected" to each, but none of them worked: 33 held the app's Client ID
 * and one its Client secret, where Shopify wants an Admin API access token
 * (`shpat_…`). Every call returned 401, and the rows were all named
 * "Shopify (Key Required) #N", so nobody could tell the stores apart either.
 */

/** Pipedream's two Shopify apps: OAuth (Client ID + secret) and the token one. */
export const SHOPIFY_APP_SLUGS = new Set(['shopify', 'shopify_developer_app']);

/** The Admin API version the check calls; any supported version answers shop.json. */
const SHOPIFY_API_VERSION = '2026-07';

/**
 * The call that asks a store who it is. Sent as a bare path when the shop ID is
 * unknown: Pipedream's proxy completes a relative path from the connected
 * account's own store. The OAuth app needs this — its shop ID is typed into
 * Pipedream's form but does not come back with the account's credentials
 * (12 Nov 2026: a real bolticc connection was refused as "no shop ID").
 */
const SHOP_PATH = `/admin/api/${SHOPIFY_API_VERSION}/shop.json`;

/** Where to point someone whose app only has a Client ID and secret. */
const OAUTH_ROUTE =
  'If your Shopify app only shows a Client ID and Client secret (apps made in the Shopify Dev ' +
  'Dashboard do), connect with "Shopify" instead of "Shopify (Key Required)" and enter those two.';

/** `domain` is null only for an OAuth store the proxy could not name. */
export type ShopifyCheck =
  | { ok: true; name: string | null; domain: string | null }
  | { ok: false; message: string };

/**
 * The store's host from Pipedream's `shop_id`, which people fill in as
 * "alnyra-com", "caliorra.myshopify.com" or a full admin URL.
 */
export function shopifyHost(shopId: string): string {
  const bare = shopId
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return bare.includes('.') ? bare : `${bare}.myshopify.com`;
}

/**
 * Why a token pasted into the token app cannot work, or null when it looks
 * like a real Admin API access token. Judged by shape alone, before any call.
 */
export function wrongShopifyToken(token: string): string | null {
  const value = token.trim();
  if (!value || value.startsWith('shpat_')) return null;
  const pasted = value.startsWith('shpss_')
    ? "the app's Client secret"
    : /^[0-9a-f]{32}$/i.test(value)
      ? "the app's Client ID (API key)"
      : 'not an Admin API access token';
  return (
    `That key is ${pasted}, so Shopify would refuse it. The token this option needs starts ` +
    `with "shpat_" and is shown once, when the app is installed on the store. ${OAUTH_ROUTE}`
  );
}

/** The HTTP status carried by a failed proxy call, when the SDK kept one. */
function statusOf(error: unknown): number | null {
  const value =
    (error as { statusCode?: unknown })?.statusCode ?? (error as { status?: unknown })?.status;
  if (typeof value === 'number') return value;
  const match = /Status code: (\d{3})/.exec(error instanceof Error ? error.message : '');
  return match ? Number(match[1]) : null;
}

/**
 * Ask the store who it is, through the same proxy Gaspo's own calls use.
 * A 401/403 or an unknown store fails the connection; anything else (a
 * timeout, Shopify having a bad minute) lets it through unnamed rather than
 * rejecting a key that may be fine.
 *
 * Only the token app insists on a shop ID: its form is the one place the ID
 * exists. An OAuth account only exists once Shopify has accepted the app's
 * secret and the merchant has approved it, so without an ID the store is asked
 * by path and named from its answer.
 */
export async function checkShopifyConnection(input: {
  appSlug: string;
  credentials: Record<string, unknown> | null;
  get: (url: string) => Promise<unknown>;
}): Promise<ShopifyCheck> {
  const shopId = String(input.credentials?.shop_id ?? '').trim();
  const known = shopId ? shopifyHost(shopId) : null;

  if (input.appSlug === 'shopify_developer_app') {
    if (!known) {
      return {
        ok: false,
        message:
          'No shop ID came through. The shop ID is the part before .myshopify.com in your ' +
          'store admin address, e.g. "acme-co" for acme-co.myshopify.com.',
      };
    }
    const wrong = wrongShopifyToken(String(input.credentials?.access_token ?? ''));
    if (wrong) return { ok: false, message: wrong };
  }

  try {
    const response = (await input.get(known ? `https://${known}${SHOP_PATH}` : SHOP_PATH)) as {
      shop?: { name?: unknown; myshopify_domain?: unknown };
    } | null;
    const name = typeof response?.shop?.name === 'string' ? response.shop.name.trim() : '';
    const reported =
      typeof response?.shop?.myshopify_domain === 'string'
        ? response.shop.myshopify_domain.trim().toLowerCase()
        : '';
    return { ok: true, name: name || null, domain: known ?? (reported || null) };
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403) {
      return {
        ok: false,
        message:
          `Shopify refused this key for ${known ?? 'the store'} (${status}), so Gaspo could not ` +
          `read it. Check the key belongs to an app installed on this store with read access. ` +
          OAUTH_ROUTE,
      };
    }
    if (status === 404 && known) {
      return {
        ok: false,
        message:
          `Shopify has no store at ${known}. The shop ID is the part before .myshopify.com in ` +
          'your store admin address.',
      };
    }
    return { ok: true, name: null, domain: known };
  }
}

/**
 * The label a checked store is listed under: its own name, and its domain to
 * tell twins apart. Null when neither is known, so the caller keeps Pipedream's.
 */
export function shopifyAccountName(check: {
  name: string | null;
  domain: string | null;
}): string | null {
  if (check.name && check.domain) return `${check.name} (${check.domain})`;
  return check.name ?? check.domain;
}
