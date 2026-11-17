import type { ToolSpec } from './providers/provider.interface';

/**
 * Local (client-side) tools for Meta Ads, executed by AiService against the
 * Meta Marketing (Graph) API using the workspace's stored Meta token — the same
 * dispatch mechanism as the Spaces and workspace-stats tools.
 *
 * These exist because Meta's hosted Ads MCP is allowlist-gated and rejects our
 * token, whereas the Marketing API accepts it directly. Reads run freely;
 * mutating tools (campaigns, ad sets, ads, and creatives) are gated behind a
 * `confirmed` flag the model may only set after the user explicitly approves.
 */

/** Tool names, shared between the definitions and AiService's dispatcher. */
export const META_ADS_LIST_AD_ACCOUNTS = 'meta_ads_list_ad_accounts';
export const META_ADS_GET_INSIGHTS = 'meta_ads_get_insights';
export const META_ADS_LIST_CAMPAIGNS = 'meta_ads_list_campaigns';
export const META_ADS_CREATE_CAMPAIGN = 'meta_ads_create_campaign';
export const META_ADS_UPDATE_CAMPAIGN = 'meta_ads_update_campaign';
export const META_ADS_DELETE_CAMPAIGN = 'meta_ads_delete_campaign';
export const META_ADS_DUPLICATE_CAMPAIGN = 'meta_ads_duplicate_campaign';
export const META_ADS_LIST_AD_SETS = 'meta_ads_list_ad_sets';
export const META_ADS_CREATE_AD_SET = 'meta_ads_create_ad_set';
export const META_ADS_UPDATE_AD_SET = 'meta_ads_update_ad_set';
export const META_ADS_DELETE_AD_SET = 'meta_ads_delete_ad_set';
export const META_ADS_DUPLICATE_AD_SET = 'meta_ads_duplicate_ad_set';
export const META_ADS_LIST_ADS = 'meta_ads_list_ads';
export const META_ADS_CREATE_AD_CREATIVE = 'meta_ads_create_ad_creative';
export const META_ADS_CREATE_AD = 'meta_ads_create_ad';
export const META_ADS_UPDATE_AD = 'meta_ads_update_ad';
export const META_ADS_DELETE_AD = 'meta_ads_delete_ad';
export const META_ADS_DUPLICATE_AD = 'meta_ads_duplicate_ad';
export const META_ADS_LIST_PAGES = 'meta_ads_list_pages';
export const META_ADS_SEARCH_INTERESTS = 'meta_ads_search_interests';

/** Names of the write (mutating) tools — each gated behind `confirmed`. */
export const META_ADS_WRITE_TOOL_NAMES = new Set<string>([
  META_ADS_CREATE_CAMPAIGN,
  META_ADS_UPDATE_CAMPAIGN,
  META_ADS_DELETE_CAMPAIGN,
  META_ADS_DUPLICATE_CAMPAIGN,
  META_ADS_CREATE_AD_SET,
  META_ADS_UPDATE_AD_SET,
  META_ADS_DELETE_AD_SET,
  META_ADS_DUPLICATE_AD_SET,
  META_ADS_CREATE_AD_CREATIVE,
  META_ADS_CREATE_AD,
  META_ADS_UPDATE_AD,
  META_ADS_DELETE_AD,
  META_ADS_DUPLICATE_AD,
]);

/** Shared `confirmed` gate: a write only runs when the user has approved it. */
const CONFIRMED_PROP = {
  confirmed: {
    type: 'boolean',
    description:
      'Must be true to execute. Only set true AFTER you have described the exact action ' +
      '(account, campaign, budget, status) to the user and they have explicitly confirmed it. ' +
      'Never set true speculatively — these actions change a live ad account and can spend money.',
  },
} as const;

const LIST_AD_ACCOUNTS_TOOL: ToolSpec = {
  name: META_ADS_LIST_AD_ACCOUNTS,
  description:
    'List the Meta (Facebook/Instagram) ad accounts the connected account can access. ' +
    'Returns each account id (e.g. "act_123"), name, currency, and status. Call this first ' +
    'to discover the ad_account_id needed by the other Meta Ads tools. Returns JSON.',
  parameters: { type: 'object', properties: {} },
};

const GET_INSIGHTS_TOOL: ToolSpec = {
  name: META_ADS_GET_INSIGHTS,
  description:
    'Get Meta Ads performance insights (spend, impressions, clicks, CTR, reach, conversions, etc.) ' +
    'for an ad account, at the account/campaign/ad set/ad level, over a preset or custom date range. ' +
    'Use for questions like "last 7 days performance for KIVOVA". Returns JSON rows.',
  parameters: {
    type: 'object',
    properties: {
      ad_account_id: {
        type: 'string',
        description:
          'The ad account id from meta_ads_list_ad_accounts, e.g. "act_1709976226241899".',
      },
      level: {
        type: 'string',
        enum: ['account', 'campaign', 'adset', 'ad'],
        description: 'Aggregation level. Defaults to "account".',
      },
      date_preset: {
        type: 'string',
        description:
          'A Meta date preset such as today, yesterday, last_7d, last_14d, last_30d, this_month, ' +
          'last_month, maximum. Omit if using since/until.',
      },
      since: {
        type: 'string',
        description: 'Start date YYYY-MM-DD (use with until instead of a preset).',
      },
      until: { type: 'string', description: 'End date YYYY-MM-DD (use with since).' },
      fields: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Insight fields to return. Defaults to spend, impressions, clicks, ctr, reach, cpc, cpm.',
      },
    },
    required: ['ad_account_id'],
  },
};

const LIST_CAMPAIGNS_TOOL: ToolSpec = {
  name: META_ADS_LIST_CAMPAIGNS,
  description:
    'List campaigns in a Meta ad account with their id, name, status (ACTIVE/PAUSED/…), objective, ' +
    'and budgets. Use for "what campaigns are running/paused?". Returns JSON.',
  parameters: {
    type: 'object',
    properties: {
      ad_account_id: {
        type: 'string',
        description:
          'The ad account id from meta_ads_list_ad_accounts, e.g. "act_1709976226241899".',
      },
      effective_status: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional status filter, e.g. ["ACTIVE"] or ["PAUSED"]. Omit for all.',
      },
    },
    required: ['ad_account_id'],
  },
};

const CREATE_CAMPAIGN_TOOL: ToolSpec = {
  name: META_ADS_CREATE_CAMPAIGN,
  description:
    'Create a new Meta Ads campaign. It is ALWAYS created PAUSED — it will not spend until you ' +
    'separately activate it (meta_ads_update_campaign with status ACTIVE), which also needs ' +
    'confirmation. Confirm the name, objective, and budget with the user before calling. Returns ' +
    'the new campaign id.',
  parameters: {
    type: 'object',
    properties: {
      ad_account_id: {
        type: 'string',
        description: 'Target ad account, e.g. "act_1709976226241899".',
      },
      name: { type: 'string', description: 'Campaign name.' },
      objective: {
        type: 'string',
        enum: [
          'OUTCOME_TRAFFIC',
          'OUTCOME_ENGAGEMENT',
          'OUTCOME_LEADS',
          'OUTCOME_SALES',
          'OUTCOME_AWARENESS',
          'OUTCOME_APP_PROMOTION',
        ],
        description: 'Campaign objective.',
      },
      daily_budget: {
        type: 'number',
        description:
          'Optional campaign daily budget in the account currency minor unit (×100, e.g. 50000 = 500 PKR).',
      },
      ...CONFIRMED_PROP,
    },
    required: ['ad_account_id', 'name', 'objective', 'confirmed'],
  },
};

const UPDATE_CAMPAIGN_TOOL: ToolSpec = {
  name: META_ADS_UPDATE_CAMPAIGN,
  description:
    'Update a campaign: rename, change daily budget, or set status. Setting status to ACTIVE ' +
    'starts delivery and spends money — always confirm with the user first. Confirm any change ' +
    'before calling.',
  parameters: {
    type: 'object',
    properties: {
      campaign_id: { type: 'string', description: 'The campaign id to update.' },
      name: { type: 'string', description: 'New campaign name (optional).' },
      status: {
        type: 'string',
        enum: ['ACTIVE', 'PAUSED'],
        description: 'ACTIVE starts spending; PAUSED stops delivery.',
      },
      daily_budget: {
        type: 'number',
        description: 'New daily budget in the account currency minor unit (×100).',
      },
      bid_strategy: {
        type: 'string',
        enum: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
        description:
          'Bid strategy for a campaign with a campaign-level budget. LOWEST_COST_WITHOUT_CAP ' +
          'needs no bid amount; the other two require a bid_amount on every ad set.',
      },
      ...CONFIRMED_PROP,
    },
    required: ['campaign_id', 'confirmed'],
  },
};

const DELETE_CAMPAIGN_TOOL: ToolSpec = {
  name: META_ADS_DELETE_CAMPAIGN,
  description:
    'Permanently delete a campaign. This is irreversible — always confirm the exact campaign ' +
    'with the user before calling.',
  parameters: {
    type: 'object',
    properties: {
      campaign_id: { type: 'string', description: 'The campaign id to delete.' },
      ...CONFIRMED_PROP,
    },
    required: ['campaign_id', 'confirmed'],
  },
};

const DUPLICATE_CAMPAIGN_TOOL: ToolSpec = {
  name: META_ADS_DUPLICATE_CAMPAIGN,
  description:
    'Duplicate an existing campaign. With deep_copy true the campaign and all its ad sets and ' +
    'ads are cloned; otherwise just the campaign shell. The copy is created PAUSED so it never ' +
    'starts spending on its own — the user activates it separately. Confirm the source campaign ' +
    'before calling.',
  parameters: {
    type: 'object',
    properties: {
      campaign_id: { type: 'string', description: 'The campaign id to duplicate.' },
      deep_copy: {
        type: 'boolean',
        description: 'True also clones the campaign’s ad sets and ads. Defaults to false.',
      },
      rename_suffix: {
        type: 'string',
        description: 'Optional text appended to copied names, e.g. " - Copy".',
      },
      ...CONFIRMED_PROP,
    },
    required: ['campaign_id', 'confirmed'],
  },
};

const LIST_AD_SETS_TOOL: ToolSpec = {
  name: META_ADS_LIST_AD_SETS,
  description:
    'List the ad sets under a campaign, with status, optimization goal, budget, and targeting. ' +
    'Returns JSON.',
  parameters: {
    type: 'object',
    properties: { campaign_id: { type: 'string', description: 'The parent campaign id.' } },
    required: ['campaign_id'],
  },
};

const CREATE_AD_SET_TOOL: ToolSpec = {
  name: META_ADS_CREATE_AD_SET,
  description:
    'Create an ad set (audience, budget, schedule) under a campaign. Always created PAUSED. ' +
    'Pick optimization_goal/billing_event to match the campaign objective (e.g. Traffic → ' +
    'optimization_goal LINK_CLICKS, billing_event IMPRESSIONS). Build targeting per Meta’s spec; ' +
    'resolve interests to ids with meta_ads_search_interests first. Confirm details with the user. ' +
    'Budget lives in one place: if the campaign has a campaign-level budget, the ad set shares it ' +
    'and daily_budget here is ignored (tell the user); otherwise the ad set needs its own.',
  parameters: {
    type: 'object',
    properties: {
      ad_account_id: { type: 'string', description: 'e.g. "act_1709976226241899".' },
      campaign_id: { type: 'string', description: 'The parent campaign id.' },
      name: { type: 'string' },
      optimization_goal: {
        type: 'string',
        description: 'e.g. LINK_CLICKS, LANDING_PAGE_VIEWS, REACH, IMPRESSIONS, POST_ENGAGEMENT.',
      },
      billing_event: { type: 'string', description: 'e.g. IMPRESSIONS or LINK_CLICKS.' },
      daily_budget: {
        type: 'number',
        description:
          'Daily budget in the account currency minor unit (×100, e.g. 50000 = 500 PKR).',
      },
      bid_amount: {
        type: 'number',
        description:
          'Bid cap or cost target in the minor unit. Only needed when the campaign uses ' +
          'LOWEST_COST_WITH_BID_CAP or COST_CAP; leave out for lowest cost.',
      },
      targeting: {
        type: 'object',
        description:
          'Meta targeting spec, e.g. {"geo_locations":{"countries":["PK"]},"age_min":25,"age_max":45,' +
          '"genders":[1],"flexible_spec":[{"interests":[{"id":"6003132926214"}]}]}.',
      },
      start_time: { type: 'string', description: 'Optional ISO start time.' },
      ...CONFIRMED_PROP,
    },
    required: [
      'ad_account_id',
      'campaign_id',
      'name',
      'optimization_goal',
      'billing_event',
      'targeting',
      'confirmed',
    ],
  },
};

const UPDATE_AD_SET_TOOL: ToolSpec = {
  name: META_ADS_UPDATE_AD_SET,
  description:
    'Update an ad set: rename, change daily budget, or set status. ACTIVE starts spending — ' +
    'confirm with the user first.',
  parameters: {
    type: 'object',
    properties: {
      ad_set_id: { type: 'string' },
      name: { type: 'string' },
      status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
      daily_budget: { type: 'number', description: 'Minor unit (×100).' },
      ...CONFIRMED_PROP,
    },
    required: ['ad_set_id', 'confirmed'],
  },
};

const DELETE_AD_SET_TOOL: ToolSpec = {
  name: META_ADS_DELETE_AD_SET,
  description: 'Permanently delete an ad set. Irreversible — confirm the exact ad set first.',
  parameters: {
    type: 'object',
    properties: { ad_set_id: { type: 'string' }, ...CONFIRMED_PROP },
    required: ['ad_set_id', 'confirmed'],
  },
};

const DUPLICATE_AD_SET_TOOL: ToolSpec = {
  name: META_ADS_DUPLICATE_AD_SET,
  description:
    'Duplicate an ad set, optionally into a different campaign (campaign_id) and optionally ' +
    'cloning its ads (deep_copy). The copy is created PAUSED. Confirm the source ad set first.',
  parameters: {
    type: 'object',
    properties: {
      ad_set_id: { type: 'string', description: 'The ad set id to duplicate.' },
      campaign_id: {
        type: 'string',
        description: 'Target campaign for the copy. Omit to clone within the same campaign.',
      },
      deep_copy: {
        type: 'boolean',
        description: 'True also clones the ad set’s ads. Defaults to false.',
      },
      rename_suffix: {
        type: 'string',
        description: 'Optional text appended to copied names, e.g. " - Copy".',
      },
      ...CONFIRMED_PROP,
    },
    required: ['ad_set_id', 'confirmed'],
  },
};

const LIST_ADS_TOOL: ToolSpec = {
  name: META_ADS_LIST_ADS,
  description: 'List the ads under an ad set, with status and creative. Returns JSON.',
  parameters: {
    type: 'object',
    properties: { ad_set_id: { type: 'string' } },
    required: ['ad_set_id'],
  },
};

const CREATE_AD_CREATIVE_TOOL: ToolSpec = {
  name: META_ADS_CREATE_AD_CREATIVE,
  description:
    'Create a link ad creative from a Facebook Page. Requires a page_id — get one from ' +
    'meta_ads_list_pages; if the account has no Page, tell the user to connect one (ads cannot run ' +
    'without it). Confirm the creative with the user before calling. Returns the creative id.',
  parameters: {
    type: 'object',
    properties: {
      ad_account_id: { type: 'string' },
      name: { type: 'string', description: 'Internal creative name.' },
      page_id: { type: 'string', description: 'The Facebook Page id to run the ad as.' },
      link: { type: 'string', description: 'Destination URL.' },
      message: { type: 'string', description: 'Primary ad text.' },
      headline: { type: 'string', description: 'Optional headline.' },
      image_url: { type: 'string', description: 'Optional image URL.' },
      call_to_action: {
        type: 'string',
        description: 'Optional CTA, e.g. LEARN_MORE, SHOP_NOW, SIGN_UP.',
      },
      ...CONFIRMED_PROP,
    },
    required: ['ad_account_id', 'name', 'page_id', 'link', 'message', 'confirmed'],
  },
};

const CREATE_AD_TOOL: ToolSpec = {
  name: META_ADS_CREATE_AD,
  description:
    'Create an ad (PAUSED) that links an ad set to a creative. Build the creative first with ' +
    'meta_ads_create_ad_creative. Confirm with the user before calling. Returns the ad id.',
  parameters: {
    type: 'object',
    properties: {
      ad_account_id: { type: 'string' },
      name: { type: 'string' },
      ad_set_id: { type: 'string' },
      creative_id: { type: 'string' },
      ...CONFIRMED_PROP,
    },
    required: ['ad_account_id', 'name', 'ad_set_id', 'creative_id', 'confirmed'],
  },
};

const UPDATE_AD_TOOL: ToolSpec = {
  name: META_ADS_UPDATE_AD,
  description:
    'Update an ad: rename or set status. ACTIVE starts delivery/spend — confirm with the user first.',
  parameters: {
    type: 'object',
    properties: {
      ad_id: { type: 'string' },
      name: { type: 'string' },
      status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] },
      ...CONFIRMED_PROP,
    },
    required: ['ad_id', 'confirmed'],
  },
};

const DELETE_AD_TOOL: ToolSpec = {
  name: META_ADS_DELETE_AD,
  description: 'Permanently delete an ad. Irreversible — confirm the exact ad first.',
  parameters: {
    type: 'object',
    properties: { ad_id: { type: 'string' }, ...CONFIRMED_PROP },
    required: ['ad_id', 'confirmed'],
  },
};

const DUPLICATE_AD_TOOL: ToolSpec = {
  name: META_ADS_DUPLICATE_AD,
  description:
    'Duplicate an ad, optionally into a different ad set (ad_set_id). The copy is created ' +
    'PAUSED. Confirm the source ad first.',
  parameters: {
    type: 'object',
    properties: {
      ad_id: { type: 'string', description: 'The ad id to duplicate.' },
      ad_set_id: {
        type: 'string',
        description: 'Target ad set for the copy. Omit to clone within the same ad set.',
      },
      rename_suffix: {
        type: 'string',
        description: 'Optional text appended to the copied name, e.g. " - Copy".',
      },
      ...CONFIRMED_PROP,
    },
    required: ['ad_id', 'confirmed'],
  },
};

const LIST_PAGES_TOOL: ToolSpec = {
  name: META_ADS_LIST_PAGES,
  description:
    'List the Facebook Pages the connected account can run ads as (needed for ad creatives). ' +
    'Returns JSON; an empty list means no Page is connected.',
  parameters: { type: 'object', properties: {} },
};

const SEARCH_INTERESTS_TOOL: ToolSpec = {
  name: META_ADS_SEARCH_INTERESTS,
  description:
    'Search Meta interest targeting options by keyword (e.g. "furniture"), returning ids to use in ' +
    'an ad set targeting spec. Returns JSON.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Interest keyword to search.' } },
    required: ['query'],
  },
};

/** The Meta Ads tool set, added to a run only when a Meta account is connected. */
export const META_ADS_TOOLS: ToolSpec[] = [
  LIST_AD_ACCOUNTS_TOOL,
  GET_INSIGHTS_TOOL,
  LIST_CAMPAIGNS_TOOL,
  CREATE_CAMPAIGN_TOOL,
  UPDATE_CAMPAIGN_TOOL,
  DELETE_CAMPAIGN_TOOL,
  DUPLICATE_CAMPAIGN_TOOL,
  LIST_AD_SETS_TOOL,
  CREATE_AD_SET_TOOL,
  UPDATE_AD_SET_TOOL,
  DELETE_AD_SET_TOOL,
  DUPLICATE_AD_SET_TOOL,
  LIST_ADS_TOOL,
  CREATE_AD_CREATIVE_TOOL,
  CREATE_AD_TOOL,
  UPDATE_AD_TOOL,
  DELETE_AD_TOOL,
  DUPLICATE_AD_TOOL,
  LIST_PAGES_TOOL,
  SEARCH_INTERESTS_TOOL,
];

/** Every Meta Ads tool name, for the AiService dispatcher. */
export const META_ADS_TOOL_NAMES = new Set<string>([
  META_ADS_LIST_AD_ACCOUNTS,
  META_ADS_GET_INSIGHTS,
  META_ADS_LIST_CAMPAIGNS,
  META_ADS_CREATE_CAMPAIGN,
  META_ADS_UPDATE_CAMPAIGN,
  META_ADS_DELETE_CAMPAIGN,
  META_ADS_DUPLICATE_CAMPAIGN,
  META_ADS_LIST_AD_SETS,
  META_ADS_CREATE_AD_SET,
  META_ADS_UPDATE_AD_SET,
  META_ADS_DELETE_AD_SET,
  META_ADS_DUPLICATE_AD_SET,
  META_ADS_LIST_ADS,
  META_ADS_CREATE_AD_CREATIVE,
  META_ADS_CREATE_AD,
  META_ADS_UPDATE_AD,
  META_ADS_DELETE_AD,
  META_ADS_DUPLICATE_AD,
  META_ADS_LIST_PAGES,
  META_ADS_SEARCH_INTERESTS,
]);
