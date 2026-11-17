import { Injectable, Logger } from '@nestjs/common';

/** Meta Graph API version used for Marketing API calls. */
const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
/** Default insight fields when the caller doesn't specify any. */
const DEFAULT_INSIGHT_FIELDS = ['spend', 'impressions', 'clicks', 'ctr', 'reach', 'cpc', 'cpm'];

/**
 * Meta Graph API error envelope. `message` is often a generic headline
 * ("Invalid parameter"); the actionable reason is in the `error_user_*` fields.
 */
interface MetaError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
}

export interface AdAccount {
  id: string;
  account_id: string;
  name: string;
  currency: string;
  account_status: number;
}

export interface InsightsParams {
  adAccountId: string;
  level?: 'account' | 'campaign' | 'adset' | 'ad';
  datePreset?: string;
  since?: string;
  until?: string;
  fields?: string[];
}

export interface CampaignsParams {
  adAccountId: string;
  effectiveStatus?: string[];
}

export interface CreateCampaignParams {
  adAccountId: string;
  name: string;
  objective: string;
  /** Daily budget in the account currency's minor unit (e.g. cents ×100). */
  dailyBudget?: number;
  lifetimeBudget?: number;
}

export interface UpdateCampaignParams {
  campaignId: string;
  name?: string;
  status?: 'ACTIVE' | 'PAUSED';
  dailyBudget?: number;
  bidStrategy?: string;
}

export interface CreateAdSetParams {
  adAccountId: string;
  campaignId: string;
  name: string;
  optimizationGoal: string;
  billingEvent: string;
  /** Meta targeting spec (geo_locations, age, genders, flexible_spec, …). */
  targeting: Record<string, unknown>;
  dailyBudget?: number;
  lifetimeBudget?: number;
  bidStrategy?: string;
  /** Bid cap / cost target in minor units; needed under a capped bid strategy. */
  bidAmount?: number;
  startTime?: string;
  endTime?: string;
}

/** The parent campaign fields an ad set's request body depends on. */
export interface CampaignBudgetInfo {
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
}

/** The strategy Meta applies when none is given; it never needs a bid amount. */
export const LOWEST_COST = 'LOWEST_COST_WITHOUT_CAP';

/** Bid strategies that reject an ad set without a `bid_amount` (error 1815857). */
const CAPPED_BID_STRATEGIES = new Set(['LOWEST_COST_WITH_BID_CAP', 'COST_CAP', 'TARGET_COST']);

function hasBudget(campaign: CampaignBudgetInfo): boolean {
  return Number(campaign.daily_budget ?? 0) > 0 || Number(campaign.lifetime_budget ?? 0) > 0;
}

/**
 * The Graph body for a new campaign. When the campaign carries its own budget
 * (Advantage campaign budget) we name the bid strategy explicitly: left out,
 * Meta defaulted a budgeted campaign to LOWEST_COST_WITH_BID_CAP (seen 17 Nov
 * 2026), and that strategy then rejects every ad set created without a bid cap.
 */
export function buildCampaignBody(params: CreateCampaignParams): Record<string, string> {
  const body: Record<string, string> = {
    name: params.name,
    objective: params.objective,
    status: 'PAUSED',
    special_ad_categories: JSON.stringify([]),
  };
  if (params.dailyBudget != null) body.daily_budget = String(params.dailyBudget);
  if (params.lifetimeBudget != null) body.lifetime_budget = String(params.lifetimeBudget);
  if (params.dailyBudget == null && params.lifetimeBudget == null) {
    // Meta requires this flag when the campaign carries no campaign-level budget
    // (ad-set budgets); false keeps ad sets from sharing budget.
    body.is_adset_budget_sharing_enabled = 'false';
  } else {
    body.bid_strategy = LOWEST_COST;
  }
  return body;
}

/**
 * The Graph body for a new ad set under `campaign`. Meta allows a budget on the
 * campaign or on its ad sets, never both ("You can only set an ad set budget or
 * a campaign budget", 1885621), and under a campaign budget every ad set shares
 * the campaign's bid strategy. So with a campaign budget the ad set's own budget
 * and strategy are left out, and a capped campaign strategy needs `bidAmount`.
 * Without a campaign budget the ad set must bring its own.
 */
export function buildAdSetBody(
  params: CreateAdSetParams,
  campaign: CampaignBudgetInfo,
): Record<string, string> {
  const targeting = { ...params.targeting };
  // Meta now requires the Advantage-audience flag in the targeting spec, so we
  // default it off when the caller omits it.
  if (!targeting.targeting_automation) targeting.targeting_automation = { advantage_audience: 0 };
  const body: Record<string, string> = {
    name: params.name,
    campaign_id: params.campaignId,
    optimization_goal: params.optimizationGoal,
    billing_event: params.billingEvent,
    targeting: JSON.stringify(targeting),
    status: 'PAUSED',
  };
  if (hasBudget(campaign)) {
    const strategy = campaign.bid_strategy ?? LOWEST_COST;
    if (CAPPED_BID_STRATEGIES.has(strategy)) {
      if (params.bidAmount == null) {
        throw new Error(
          `Campaign ${params.campaignId} has a campaign budget with bid strategy ${strategy}, ` +
            `which needs a bid cap: pass bid_amount (minor units), or first set the campaign's ` +
            `bid_strategy to ${LOWEST_COST} with meta_ads_update_campaign.`,
        );
      }
      body.bid_amount = String(params.bidAmount);
    }
  } else {
    if (params.dailyBudget == null && params.lifetimeBudget == null) {
      throw new Error(
        `Campaign ${params.campaignId} has no campaign budget, so the ad set needs a ` +
          `daily_budget or lifetime_budget.`,
      );
    }
    if (params.dailyBudget != null) body.daily_budget = String(params.dailyBudget);
    if (params.lifetimeBudget != null) body.lifetime_budget = String(params.lifetimeBudget);
    body.bid_strategy =
      params.bidStrategy ?? (params.bidAmount != null ? 'LOWEST_COST_WITH_BID_CAP' : LOWEST_COST);
    if (params.bidAmount != null) body.bid_amount = String(params.bidAmount);
  }
  if (params.startTime) body.start_time = params.startTime;
  if (params.endTime) body.end_time = params.endTime;
  return body;
}

export interface UpdateAdSetParams {
  adSetId: string;
  name?: string;
  status?: 'ACTIVE' | 'PAUSED';
  dailyBudget?: number;
}

export interface CreateAdCreativeParams {
  adAccountId: string;
  name: string;
  pageId: string;
  link: string;
  message: string;
  imageUrl?: string;
  headline?: string;
  callToAction?: string;
}

export interface CreateAdParams {
  adAccountId: string;
  name: string;
  adSetId: string;
  creativeId: string;
}

export interface UpdateAdParams {
  adId: string;
  name?: string;
  status?: 'ACTIVE' | 'PAUSED';
}

/**
 * How a copy is left after duplication. Always defaults to PAUSED at the tool
 * layer so a clone never starts spending on its own; INHERITED keeps the
 * source's status (which may be ACTIVE) and must only be used on explicit ask.
 */
export type CopyStatusOption = 'PAUSED' | 'ACTIVE' | 'INHERITED_FROM_SOURCE';

export interface DuplicateCampaignParams {
  campaignId: string;
  /** Also copy the campaign's ad sets and ads, not just the campaign shell. */
  deepCopy?: boolean;
  statusOption?: CopyStatusOption;
  /** Appended to copied object names, e.g. ' - Copy'. */
  renameSuffix?: string;
}

export interface DuplicateAdSetParams {
  adSetId: string;
  /** Target campaign for the copy; omit to clone within the same campaign. */
  campaignId?: string;
  /** Also copy the ad set's ads. */
  deepCopy?: boolean;
  statusOption?: CopyStatusOption;
  renameSuffix?: string;
}

export interface DuplicateAdParams {
  adId: string;
  /** Target ad set for the copy; omit to clone within the same ad set. */
  adSetId?: string;
  statusOption?: CopyStatusOption;
  renameSuffix?: string;
}

/**
 * A thin client for the Meta Marketing (Graph) API, used by the Meta Ads local
 * tools — reporting reads plus campaign / ad set / ad / creative management. It
 * is deliberately stateless: the caller passes the access token (refreshed by
 * {@link IntegrationsService}), mirroring how PipedreamService keeps token/DB
 * concerns out of its request helpers.
 *
 * This is the fallback path for Meta Ads because Meta's hosted Ads MCP is
 * allowlist-gated and rejects our token, whereas the Marketing API accepts it.
 */
@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name);

  /** List the ad accounts the token can access. */
  listAdAccounts(accessToken: string): Promise<{ data: AdAccount[] }> {
    return this.get('me/adaccounts', accessToken, {
      fields: 'id,account_id,name,currency,account_status',
      limit: '100',
    });
  }

  /** Performance insights for an ad account at the requested level/date range. */
  getInsights(accessToken: string, params: InsightsParams): Promise<{ data: unknown[] }> {
    const query: Record<string, string> = {
      level: params.level ?? 'account',
      fields: (params.fields?.length ? params.fields : DEFAULT_INSIGHT_FIELDS).join(','),
    };
    if (params.since && params.until) {
      query.time_range = JSON.stringify({ since: params.since, until: params.until });
    } else {
      query.date_preset = params.datePreset ?? 'last_7d';
    }
    return this.get(`${this.normalizeAccount(params.adAccountId)}/insights`, accessToken, query);
  }

  /** Campaigns in an ad account, optionally filtered by status. */
  listCampaigns(accessToken: string, params: CampaignsParams): Promise<{ data: unknown[] }> {
    const query: Record<string, string> = {
      fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget',
      limit: '100',
    };
    if (params.effectiveStatus?.length) {
      query.effective_status = JSON.stringify(params.effectiveStatus);
    }
    return this.get(`${this.normalizeAccount(params.adAccountId)}/campaigns`, accessToken, query);
  }

  /**
   * Create a campaign. Deliberately forced to `PAUSED` on creation so nothing
   * starts spending until an explicit, separately-confirmed activate. Meta
   * requires `special_ad_categories` (empty array for ordinary campaigns).
   */
  createCampaign(accessToken: string, params: CreateCampaignParams): Promise<{ id: string }> {
    return this.post(
      `${this.normalizeAccount(params.adAccountId)}/campaigns`,
      accessToken,
      buildCampaignBody(params),
    );
  }

  /** Update a campaign's name, status (activate/pause), daily budget or bid strategy. */
  updateCampaign(accessToken: string, params: UpdateCampaignParams): Promise<{ success: boolean }> {
    const body: Record<string, string> = {};
    if (params.name != null) body.name = params.name;
    if (params.status != null) body.status = params.status;
    if (params.dailyBudget != null) body.daily_budget = String(params.dailyBudget);
    if (params.bidStrategy != null) body.bid_strategy = params.bidStrategy;
    return this.post(params.campaignId, accessToken, body);
  }

  /** Delete (permanently) a campaign. */
  deleteCampaign(accessToken: string, campaignId: string): Promise<{ success: boolean }> {
    return this.request(campaignId, accessToken, {}, 'DELETE');
  }

  /**
   * Duplicate a campaign via Graph's `/copies`. With `deepCopy` the whole tree
   * (ad sets and ads) is cloned; otherwise just the campaign shell. The copy is
   * PAUSED unless the caller overrides it, so a duplicate never spends on its
   * own. Returns Meta's copy result (e.g. `copied_campaign_id`).
   */
  duplicateCampaign(
    accessToken: string,
    params: DuplicateCampaignParams,
  ): Promise<Record<string, unknown>> {
    return this.post(`${params.campaignId}/copies`, accessToken, {
      deep_copy: String(params.deepCopy ?? false),
      ...this.copyOptions(params.statusOption, params.renameSuffix, params.deepCopy),
    });
  }

  // ── Ad sets ────────────────────────────────────────────────────────────────

  /** List ad sets under a campaign. */
  listAdSets(accessToken: string, campaignId: string): Promise<{ data: unknown[] }> {
    return this.get(`${campaignId}/adsets`, accessToken, {
      fields:
        'id,name,status,effective_status,optimization_goal,billing_event,daily_budget,targeting',
      limit: '100',
    });
  }

  /**
   * List every ad set in an ad account with its status and daily budget — used
   * by the rule engine to resolve an ad set's current budget when scaling it
   * (the account-wide analogue of {@link listAdSets}, which is per-campaign).
   */
  listAdSetsForAccount(accessToken: string, adAccountId: string): Promise<{ data: unknown[] }> {
    return this.get(`${this.normalizeAccount(adAccountId)}/adsets`, accessToken, {
      fields: 'id,name,status,effective_status,campaign_id,daily_budget',
      limit: '200',
    });
  }

  /**
   * Create an ad set (PAUSED). The body depends on whether the parent campaign
   * carries its own budget, see {@link buildAdSetBody}, so the campaign is read first.
   */
  async createAdSet(accessToken: string, params: CreateAdSetParams): Promise<{ id: string }> {
    const campaign = await this.get<CampaignBudgetInfo>(params.campaignId, accessToken, {
      fields: 'daily_budget,lifetime_budget,bid_strategy',
    });
    return this.post(
      `${this.normalizeAccount(params.adAccountId)}/adsets`,
      accessToken,
      buildAdSetBody(params, campaign),
    );
  }

  /** Update an ad set's name, status, or daily budget. */
  updateAdSet(accessToken: string, params: UpdateAdSetParams): Promise<{ success: boolean }> {
    const body: Record<string, string> = {};
    if (params.name != null) body.name = params.name;
    if (params.status != null) body.status = params.status;
    if (params.dailyBudget != null) body.daily_budget = String(params.dailyBudget);
    return this.post(params.adSetId, accessToken, body);
  }

  /** Delete (permanently) an ad set. */
  deleteAdSet(accessToken: string, adSetId: string): Promise<{ success: boolean }> {
    return this.request(adSetId, accessToken, {}, 'DELETE');
  }

  /**
   * Duplicate an ad set via `/copies`, optionally into a different campaign and
   * optionally copying its ads (`deepCopy`). PAUSED unless overridden.
   */
  duplicateAdSet(
    accessToken: string,
    params: DuplicateAdSetParams,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, string> = {
      deep_copy: String(params.deepCopy ?? false),
      ...this.copyOptions(params.statusOption, params.renameSuffix, params.deepCopy),
    };
    if (params.campaignId) body.campaign_id = params.campaignId;
    return this.post(`${params.adSetId}/copies`, accessToken, body);
  }

  // ── Ads & creatives ─────────────────────────────────────────────────────────

  /** List ads under an ad set. */
  listAds(accessToken: string, adSetId: string): Promise<{ data: unknown[] }> {
    return this.get(`${adSetId}/ads`, accessToken, {
      fields: 'id,name,status,effective_status,creative',
      limit: '100',
    });
  }

  /**
   * Create a link ad creative from a Page post spec. Requires a `page_id` — the
   * ad account must have a connected Facebook Page, or Meta rejects this.
   */
  createAdCreative(accessToken: string, params: CreateAdCreativeParams): Promise<{ id: string }> {
    const linkData: Record<string, unknown> = { link: params.link, message: params.message };
    if (params.headline) linkData.name = params.headline;
    if (params.imageUrl) linkData.picture = params.imageUrl;
    if (params.callToAction) {
      linkData.call_to_action = { type: params.callToAction, value: { link: params.link } };
    }
    return this.post(`${this.normalizeAccount(params.adAccountId)}/adcreatives`, accessToken, {
      name: params.name,
      object_story_spec: JSON.stringify({ page_id: params.pageId, link_data: linkData }),
    });
  }

  /** Create an ad (PAUSED) linking an ad set to a creative. */
  createAd(accessToken: string, params: CreateAdParams): Promise<{ id: string }> {
    return this.post(`${this.normalizeAccount(params.adAccountId)}/ads`, accessToken, {
      name: params.name,
      adset_id: params.adSetId,
      creative: JSON.stringify({ creative_id: params.creativeId }),
      status: 'PAUSED',
    });
  }

  /** Update an ad's name or status. */
  updateAd(accessToken: string, params: UpdateAdParams): Promise<{ success: boolean }> {
    const body: Record<string, string> = {};
    if (params.name != null) body.name = params.name;
    if (params.status != null) body.status = params.status;
    return this.post(params.adId, accessToken, body);
  }

  /** Delete (permanently) an ad. */
  deleteAd(accessToken: string, adId: string): Promise<{ success: boolean }> {
    return this.request(adId, accessToken, {}, 'DELETE');
  }

  /**
   * Duplicate an ad via `/copies`, optionally into a different ad set. Ads have
   * no children, so there is no deep copy. PAUSED unless overridden.
   */
  duplicateAd(accessToken: string, params: DuplicateAdParams): Promise<Record<string, unknown>> {
    const body: Record<string, string> = {
      ...this.copyOptions(params.statusOption, params.renameSuffix, false),
    };
    if (params.adSetId) body.adset_id = params.adSetId;
    return this.post(`${params.adId}/copies`, accessToken, body);
  }

  /**
   * Shared `/copies` options: a safe default status (PAUSED) and, when a suffix
   * is given, a rename spec that reaches child objects on a deep copy so clones
   * do not collide by name with their source.
   */
  private copyOptions(
    statusOption: CopyStatusOption | undefined,
    renameSuffix: string | undefined,
    deepCopy: boolean | undefined,
  ): Record<string, string> {
    const options: Record<string, string> = {
      status_option: statusOption ?? 'PAUSED',
    };
    if (renameSuffix) {
      options.rename_options = JSON.stringify({
        rename_strategy: deepCopy ? 'DEEP_RENAME' : 'ONLY_TOP_LEVEL_RENAME',
        rename_suffix: renameSuffix,
      });
    }
    return options;
  }

  // ── Discovery helpers ───────────────────────────────────────────────────────

  /** The Facebook Pages the account can run ads as (needed for creatives). */
  listPages(accessToken: string): Promise<{ data: unknown[] }> {
    return this.get('me/accounts', accessToken, { fields: 'id,name', limit: '100' });
  }

  /** Search Meta interest targeting options by keyword. */
  searchInterests(accessToken: string, query: string): Promise<{ data: unknown[] }> {
    return this.get('search', accessToken, { type: 'adinterest', q: query, limit: '15' });
  }

  /** Ensure an ad account id carries the `act_` prefix the Graph API expects. */
  private normalizeAccount(id: string): string {
    return id.startsWith('act_') ? id : `act_${id}`;
  }

  /**
   * Issue a GET against the Graph API, translating Meta's error envelope into a
   * thrown Error the tool dispatcher can surface to the model.
   */
  private async get<T>(
    path: string,
    accessToken: string,
    query: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${GRAPH_BASE}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    url.searchParams.set('access_token', accessToken);

    const res = await fetch(url.toString());
    const body = (await res.json().catch(() => ({}))) as { error?: MetaError } & Record<
      string,
      unknown
    >;
    if (!res.ok || body.error) {
      const message = this.metaErrorMessage(body.error, res.status);
      this.logger.warn(`Meta Graph ${path} failed: ${message}`);
      throw new Error(message);
    }
    return body as T;
  }

  /** POST convenience wrapper for mutations. */
  private post<T>(path: string, accessToken: string, params: Record<string, string>): Promise<T> {
    return this.request(path, accessToken, params, 'POST');
  }

  /**
   * Issue a mutating Graph API request (POST/DELETE), sending params + token as a
   * form body and translating Meta's error envelope into a thrown Error.
   */
  private async request<T>(
    path: string,
    accessToken: string,
    params: Record<string, string>,
    method: 'POST' | 'DELETE',
  ): Promise<T> {
    const body = new URLSearchParams({ ...params, access_token: accessToken });
    const res = await fetch(`${GRAPH_BASE}/${path}`, {
      method,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: MetaError } & Record<
      string,
      unknown
    >;
    if (!res.ok || json.error) {
      const message = this.metaErrorMessage(json.error, res.status);
      this.logger.warn(`Meta Graph ${method} ${path} failed: ${message}`);
      throw new Error(message);
    }
    return json as T;
  }

  /**
   * Build a human, actionable message from Meta's error envelope. Meta's generic
   * `message` is often just "Invalid parameter"; the real, user-facing reason is
   * in `error_user_title`/`error_user_msg` (e.g. "Budget is too small"), so we
   * prefer those when present.
   */
  private metaErrorMessage(error: MetaError | undefined, status: number): string {
    if (!error) return `Meta API error (HTTP ${status})`;
    const title = error.error_user_title?.trim();
    const detail = error.error_user_msg?.trim();
    if (title && detail) return title === detail ? title : `${title}: ${detail}`;
    return detail || title || error.message || `Meta API error (HTTP ${status})`;
  }
}
