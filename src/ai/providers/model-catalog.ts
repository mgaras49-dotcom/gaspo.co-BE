import { Logger } from '@nestjs/common';

/**
 * The models Gaspo can run on, and what they cost.
 *
 * This is the single source of truth for the settings picker, provider routing,
 * and credit pricing — the SPA renders whatever this serves, so a model can
 * never be offered that the runtime cannot actually reach.
 */

export type ProviderId = 'anthropic' | 'gateway';

export interface ModelBadge {
  type: 'recommended' | 'discount' | 'premium' | 'beta' | 'deprecated';
  value?: string;
}

export interface ModelDefinition {
  id: string;
  name: string;
  description: string;
  provider: ProviderId;
  /** List price per million input tokens, in US dollars. */
  inputPricePerMillion: number;
  /** List price per million output tokens, in US dollars. */
  outputPricePerMillion: number;
  /**
   * What the provider actually bills us per million tokens, when that differs
   * from list — an introductory rate, or a negotiated one. List price sets what
   * a workspace is charged and must not move when a promotion starts and ends;
   * these set what we record as our own cost. Default to the list prices.
   */
  costInputPricePerMillion?: number;
  costOutputPricePerMillion?: number;
  /**
   * Whether the model can call tools. Gaspo is entirely tool-driven, so a model
   * without this cannot run it and is never offered in settings.
   */
  supportsTools: boolean;
  /**
   * Whether the provider connects to remote MCP servers itself. False means
   * connected apps reach the model through our own MCP bridge instead.
   */
  supportsRemoteMcp: boolean;
  /**
   * Anthropic only: whether `thinking: {type:'adaptive'}` is accepted. The
   * pre-4.6 models reject it with a 400 and must be sent no thinking config.
   */
  supportsAdaptiveThinking?: boolean;
  badges?: ModelBadge[];
}

/**
 * How many credits a dollar buys. Four hundred puts one credit at a quarter of
 * a cent, which is the denomination the subscription plans are sized in.
 *
 * The number is cosmetic to the arithmetic — every rate below is derived from
 * it — but not to the customer: a finer credit makes an allowance read as
 * 40,000 rather than 10,000 for the same money. Changing it rescales every
 * balance in the database, so it moves only alongside a migration that
 * multiplies the existing ledger by the same factor.
 */
export const CREDITS_PER_DOLLAR = 400;

/**
 * Multiple of list price charged to a workspace.
 *
 * One means a workspace is charged exactly what the provider charges us for the
 * tokens, which is what the pricing page claims. The margin is deliberately not
 * here: it comes from unspent plan credits expiring, from prompt caching we pay
 * for and the customer does not, and from buying inference below list — see
 * `costInputPricePerMillion` below, which is what a token really costs us.
 *
 * Raising this above 1 puts a markup back on model costs and makes the pricing
 * page's "no markup" claim false. That is a copy change as much as a code one.
 */
export const CREDIT_MARGIN = 1;

/**
 * Anthropic's price for one web search: $10 per 1,000, on top of the tokens its
 * results add. Web fetch has no per-use fee, only tokens. Charged to the
 * workspace at the same margin as tokens.
 */
export const WEB_SEARCH_PRICE_USD = 0.01;

/** Credits charged for a run's web searches. */
export function webSearchCredits(searches: number): number {
  return Math.max(0, searches) * WEB_SEARCH_PRICE_USD * CREDITS_PER_DOLLAR * CREDIT_MARGIN;
}

/**
 * Anthropic models, priced from Anthropic's published rates. Every one supports
 * tool use, the server-side MCP connector, and prompt caching.
 *
 * Deliberately short: Sonnet 5 for everyday work and Opus 5.5 for when a
 * workspace wants the strongest model. Opus 4.8 stays only so workspaces and
 * tasks that already pinned it keep resolving. Offering the whole Anthropic
 * line-up made the picker a quiz with no right answer, and the older Opus and
 * Sonnet generations cost as much as the current ones while performing worse.
 */
const ANTHROPIC_MODELS: ModelDefinition[] = [
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    description:
      'Near-Opus quality on everyday agent work at 40% less. The default, and the right choice for most workspaces.',
    provider: 'anthropic',
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    // Anthropic's introductory rate (2 / 10) lapsed on 2026-08-31; cost
    // recording now falls back to list price. Set the cost overrides again only
    // if a negotiated rate replaces it.
    supportsTools: true,
    supportsRemoteMcp: true,
    supportsAdaptiveThinking: true,
    badges: [{ type: 'recommended' }, { type: 'discount', value: '−40%' }],
  },
  {
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    description:
      'The strongest model, for complex research, analysis and multi-step work. Costs about a ' +
      'third more than Sonnet 5.',
    provider: 'anthropic',
    inputPricePerMillion: 4,
    outputPricePerMillion: 20,
    supportsTools: true,
    supportsRemoteMcp: true,
    supportsAdaptiveThinking: true,
    badges: [{ type: 'premium', value: '+33%' }],
  },
  {
    id: 'claude-opus-4-8',
    name: 'Claude Opus 4.8',
    description:
      'The previous Opus, kept for workspaces already using it. Opus 5.5 is stronger and cheaper.',
    provider: 'anthropic',
    inputPricePerMillion: 5,
    outputPricePerMillion: 25,
    supportsTools: true,
    supportsRemoteMcp: true,
    supportsAdaptiveThinking: true,
    badges: [{ type: 'premium', value: '+67%' }, { type: 'deprecated' }],
  },
];

/** One entry of the `AI_GATEWAY_MODELS` JSON array. */
interface GatewayModelConfig {
  id: string;
  name: string;
  description?: string;
  inputPricePerMillion: number;
  outputPricePerMillion: number;
  supportsTools?: boolean;
  badges?: ModelBadge[];
}

const logger = new Logger('ModelCatalog');

/**
 * Gateway models are declared in config rather than hardcoded: which ids exist
 * and what they cost depends on the gateway the deployment points at, so
 * baking in one vendor's naming would break the moment it is swapped.
 */
function parseGatewayModels(raw: string): ModelDefinition[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`AI_GATEWAY_MODELS is not valid JSON, ignoring it: ${message}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.error('AI_GATEWAY_MODELS must be a JSON array, ignoring it');
    return [];
  }
  const models: ModelDefinition[] = [];
  for (const entry of parsed as GatewayModelConfig[]) {
    if (!entry?.id || !entry?.name) {
      logger.warn('Skipping an AI_GATEWAY_MODELS entry without an id and name');
      continue;
    }
    models.push({
      id: entry.id,
      name: entry.name,
      description: entry.description ?? '',
      provider: 'gateway',
      inputPricePerMillion: Number(entry.inputPricePerMillion) || 0,
      outputPricePerMillion: Number(entry.outputPricePerMillion) || 0,
      // Gaspo is tool-driven end to end, so a model is only usable if it does
      // function calling. Opt in explicitly — many cheap models advertise it
      // and then ignore the tools.
      supportsTools: entry.supportsTools ?? false,
      supportsRemoteMcp: false,
      badges: entry.badges,
    });
  }
  return models;
}

/** Every known model, Anthropic's fixed set plus whatever the gateway declares. */
export function buildCatalog(gatewayModelsJson: string): ModelDefinition[] {
  return [...ANTHROPIC_MODELS, ...parseGatewayModels(gatewayModelsJson)];
}

/**
 * Credits charged per 1K input and output tokens.
 *
 * A price is quoted per million tokens, so a thousand tokens cost
 * dollars-per-million ÷ 1000, which is then converted into credits and marked
 * up. At 400 credits to the dollar and no markup, Opus lands at 2 credits per
 * 1K input and 10 per 1K output — half a cent and two and a half cents, which
 * is exactly Anthropic's list price.
 */
export function creditRates(model: ModelDefinition): { input: number; output: number } {
  const perCredit = (pricePerMillion: number) =>
    (pricePerMillion / 1000) * CREDITS_PER_DOLLAR * CREDIT_MARGIN;
  return {
    input: perCredit(model.inputPricePerMillion),
    output: perCredit(model.outputPricePerMillion),
  };
}

/**
 * The TTL every cache breakpoint asks for, and the write multiplier that TTL is
 * billed at. The two are declared together because they cannot move
 * independently: Anthropic bills a 1h write at 2x the base input rate where a
 * 5m write is 1.25x, so changing one without the other silently misprices every
 * cached run — and since we charge credits off this number, undercharging comes
 * straight out of margin.
 *
 * 1h is the trade Slack asks for. A thread resumes on human time: the follow-up
 * to an answer lands minutes or hours later, and under the 5-minute default
 * every one of those was a full miss that re-paid a write at 1.25x rather than
 * reading at 0.1x. Paying 2x once to read the rest of the conversation back all
 * day is the cheaper side of that trade by a wide margin.
 *
 * A read stays a tenth of the input rate either way, so a run whose prompt is
 * mostly a cache hit costs a small fraction of what its token count suggests —
 * which is the reason cost cannot be derived from a prompt size alone.
 */
export const CACHE_TTL = '1h' as const;
const CACHE_WRITE_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

/** The cached slices of a run's prompt, as reported by the provider. */
export interface CacheTokens {
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

/**
 * What a run costs us, in USD — the input side of margin, as opposed to
 * {@link creditRates} which is what we charge for it.
 *
 * Used for providers that do not report a real per-response cost. A gateway
 * that does report one should be trusted over this, since a router's list price
 * is a guess about which backend it picked.
 *
 * `inputTokens` is the whole prompt including its cached slices, so those are
 * subtracted back out and re-priced at their own rates. A provider that reports
 * no cache split prices as if nothing were cached, which is the correct answer
 * for a provider that does no caching.
 */
export function listCostUsd(
  model: ModelDefinition,
  inputTokens: number,
  outputTokens: number,
  cache: CacheTokens = {},
): number {
  const inputPrice = model.costInputPricePerMillion ?? model.inputPricePerMillion;
  const outputPrice = model.costOutputPricePerMillion ?? model.outputPricePerMillion;

  const cacheWrites = Math.max(0, cache.cacheWriteTokens ?? 0);
  const cacheReads = Math.max(0, cache.cacheReadTokens ?? 0);
  // Guard against a provider reporting cached slices larger than the prompt
  // itself; a negative uncached remainder would credit us for the run.
  const uncached = Math.max(0, inputTokens - cacheWrites - cacheReads);

  return (
    (uncached / 1_000_000) * inputPrice +
    (cacheWrites / 1_000_000) * inputPrice * CACHE_WRITE_MULTIPLIER +
    (cacheReads / 1_000_000) * inputPrice * CACHE_READ_MULTIPLIER +
    (outputTokens / 1_000_000) * outputPrice
  );
}
