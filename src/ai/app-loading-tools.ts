import type { RemoteMcpServer, ToolSpec } from './providers/provider.interface';

/**
 * A local tool that widens a connected app's toolset partway through a run.
 *
 * Each message reaches the model with only the app actions a cheap router
 * guessed it needed. When the guess fell short the model had no way to ask for
 * more, so it concluded the app itself could not do the thing: "I can't create
 * Gmail drafts — I only have read/search access" with Gmail's send and draft
 * actions one routing call away. This gives it that call.
 */
export const LOAD_APP_TOOLS = 'load_app_tools';

export const LOAD_APP_TOOLS_TOOL: ToolSpec = {
  name: LOAD_APP_TOOLS,
  description:
    'Connected apps arrive with only the actions this message looked like it needed, so an app ' +
    'can usually do more than the tools you can see. Call this when you need an action of a ' +
    'connected app that you do not have — for example you can search Gmail but need to draft, ' +
    'send or mark emails read; you can read Google Ads but need to change a budget; YouTube is ' +
    'connected but you need to upload — or when an app listed as connected has no tools here at ' +
    'all. Name the app and say what you need to do; the matching actions are added and you can ' +
    'call them straight away. Never tell the user a connected app cannot do something until you ' +
    'have called this for it.',
  parameters: {
    type: 'object',
    properties: {
      app: {
        type: 'string',
        description:
          'The connected app, by name or id as listed in your instructions, e.g. "Gmail" or "google_ads".',
      },
      account: {
        type: 'string',
        description:
          "Only when the app has several accounts connected: which one, e.g. a Shopify store's " +
          'name. Leave it out to load the actions for every account of the app.',
      },
      need: {
        type: 'string',
        description: 'What you need to do with it, in plain words, e.g. "draft and send a reply".',
      },
    },
    required: ['app', 'need'],
  },
};

/** Lower-case and fold separators, so "Google Ads", "google_ads" and "google-ads" meet. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

/**
 * The workspace servers a model's app reference points at. Matches the app id
 * or its display name, exactly first and then by containment, so "Shopify"
 * finds `shopify_developer_app` but "Google" alone does not pick an arbitrary
 * Google app when an exact match exists. Every server of the matched app is
 * returned: a team and a private account of one app are two servers.
 */
export function matchAppServers(
  reference: string,
  servers: RemoteMcpServer[],
  appNames: Map<string, string>,
  account?: string,
): RemoteMcpServer[] {
  const wanted = normalise(reference);
  if (!wanted) return [];
  const labels = (server: RemoteMcpServer) => [
    normalise(server.appSlug),
    normalise(appNames.get(server.appSlug) ?? ''),
  ];
  const exact = servers.filter((server) => labels(server).includes(wanted));
  const apps = exact.length
    ? exact
    : servers.filter((server) =>
        labels(server).some((label) => label && (label.includes(wanted) || wanted.includes(label))),
      );
  const store = normalise(account ?? '');
  if (!store) return apps;
  // A named account narrows to the servers pinned to it; an app served whole
  // has no accounts to choose between, so it stays.
  return apps.filter(
    (server) => !server.accountLabel || normalise(server.accountLabel).includes(store),
  );
}
