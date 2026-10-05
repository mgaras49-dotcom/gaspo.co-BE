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

/** Where to point someone whose app only has a Client ID and secret. */
const OAUTH_ROUTE =
  'If your Shopify app only shows a Client ID and Client secret (apps made in the Shopify Dev ' +
  'Dashboard do), connect with "Shopify" instead of "Shopify (Key Required)" and enter those two.';

export type ShopifyCheck =
  | { ok: true; name: string | null; domain: string }
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
 */
export async function checkShopifyConnection(input: {
  appSlug: string;
  credentials: Record<string, unknown> | null;
  get: (url: string) => Promise<unknown>;
}): Promise<ShopifyCheck> {
  const shopId = String(input.credentials?.shop_id ?? '').trim();
  if (!shopId) {
    return {
      ok: false,
      message:
        'No shop ID came through. The shop ID is the part before .myshopify.com in your store ' +
        'admin address, e.g. "acme-co" for acme-co.myshopify.com.',
    };
  }
  const domain = shopifyHost(shopId);

  if (input.appSlug === 'shopify_developer_app') {
    const wrong = wrongShopifyToken(String(input.credentials?.access_token ?? ''));
    if (wrong) return { ok: false, message: wrong };
  }

  try {
    const response = (await input.get(
      `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
    )) as { shop?: { name?: unknown } } | null;
    const name = typeof response?.shop?.name === 'string' ? response.shop.name.trim() : '';
    return { ok: true, name: name || null, domain };
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403) {
      return {
        ok: false,
        message:
          `Shopify refused this key for ${domain} (${status}), so Gaspo could not read the store. ` +
          `Check the key belongs to an app installed on this store with read access. ${OAUTH_ROUTE}`,
      };
    }
    if (status === 404) {
      return {
        ok: false,
        message:
          `Shopify has no store at ${domain}. The shop ID is the part before .myshopify.com in ` +
          'your store admin address.',
      };
    }
    return { ok: true, name: null, domain };
  }
}

/** The label a checked store is listed under: its own name, and its domain to tell twins apart. */
export function shopifyAccountName(check: { name: string | null; domain: string }): string {
  return check.name ? `${check.name} (${check.domain})` : check.domain;
}
