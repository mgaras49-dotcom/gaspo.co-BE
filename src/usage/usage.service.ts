import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import {
  CREDIT_MARGIN,
  CREDITS_PER_DOLLAR,
  buildCatalog,
  creditRates,
  listCostUsd,
  WEB_SEARCH_PRICE_USD,
  webSearchCredits,
} from '../ai/providers/model-catalog';
import { CreditBucket, CreditEventType, CreditGrantReason } from '../common/enums';
import { AppConfig } from '../config/configuration';
import { UsersService } from '../users/users.service';
import { CreditAllocation, CreditEvent, CreditGrant, ScheduledTask } from '../database/entities';

export interface UsageSummary {
  totalCreditsUsed: number;
  totalTokensUsed: number;
  eventCount: number;
}

/** What one bucket still holds, and when the soonest slice of it dies. */
export interface BucketBalance {
  bucket: CreditBucket;
  credits: number;
  /** Earliest expiry among the grants making up this bucket; null if none expire. */
  expiresAt: Date | null;
}

/**
 * A workspace's credit position.
 *
 * `granted`, `used` and `balance` keep their original meanings so existing
 * callers (the admin overview, the billing page) are unaffected — but `balance`
 * now counts only *live* credits, since expired ones cannot be spent. The
 * difference between the two is `expired`, reported separately rather than
 * quietly folded into `used`: credits that ran out and credits that were
 * consumed are very different conversations to have with a customer.
 */
export interface CreditBalance {
  granted: number;
  used: number;
  balance: number;
  expired: number;
  buckets: BucketBalance[];
}

export { CREDITS_PER_DOLLAR };

/**
 * Free trial credits, granted per seat rather than per workspace.
 *
 * Per seat because the trial has to feel the same size to a solo founder and to
 * a team of six: a flat workspace grant is generous to one and a rounding error
 * to the other. These land in the REWARD bucket, so they never expire and are
 * spent last — a workspace that later subscribes keeps whatever trial it never
 * got round to using.
 *
 * Both figures are derived from {@link CREDITS_PER_DOLLAR} rather than written
 * as credit counts. Writing the count directly is what broke this once already:
 * the literal survived the move from 100 to 400 credits per dollar unchanged,
 * quietly cutting the trial from $100 to $25.
 */
export const TRIAL_CREDITS_PER_SEAT = 25 * CREDITS_PER_DOLLAR;

/**
 * The smallest trial any workspace gets, regardless of seat count.
 *
 * The public pricing page promises $100 in credits, and most signups are a
 * single seat — so without a floor the headline is false for almost everyone
 * who reads it. Teams above four seats scale past this on the per-seat rate.
 */
export const TRIAL_CREDITS_FLOOR = 100 * CREDITS_PER_DOLLAR;

/**
 * Seats a plan carries before the per-seat bonus starts, the bonus each further
 * seat earns per period, and the ceiling on the total.
 *
 * The cap matters: without it a large team's bonus grows without bound and the
 * plan's economics invert somewhere north of a few hundred seats.
 */
export const FREE_SEATS = 4;
export const SEAT_BONUS_CREDITS = 25 * CREDITS_PER_DOLLAR;
export const SEAT_BONUS_CAP = 1_000 * CREDITS_PER_DOLLAR;

/**
 * Query-builder alias for `credit_grants`, deliberately not `grant`.
 *
 * GRANT is a reserved word in Postgres, so an unquoted `grant` alias is a
 * syntax error. TypeORM hides this most of the time: it rewrites the
 * `alias.property` form into `"alias"."column"`, quoting as it goes. But a raw
 * fragment that already names the column itself — `grant."expiresAt"`,
 * `MIN(grant."expiresAt")` — does not match that pattern and is passed through
 * verbatim, alias unquoted, and the query dies at runtime with nothing failing
 * at compile time.
 *
 * Mixing the two forms in one builder is what shipped a broken balance query to
 * production. Naming the alias something unreserved makes both forms safe, so
 * the trap cannot be re-laid by writing a perfectly ordinary WHERE clause.
 */
export const GRANT_ALIAS = 'credit_grant';

/**
 * The order buckets are drained in: soonest to expire first, never-expiring
 * last. Rollover dies at the end of this period and plan credits at the end of
 * the next, so spending rollover first is simply spending what would otherwise
 * be lost.
 *
 * The consequence is worth stating plainly, because it is the whole design:
 * top-up and reward credits are only ever reached once the subscription
 * allowance is exhausted. A workspace that stays inside its plan never touches
 * them, which is why reward credits can be handed out freely — most are never
 * redeemed.
 */
export const SPEND_ORDER: readonly CreditBucket[] = [
  CreditBucket.ROLLOVER,
  CreditBucket.PLAN,
  CreditBucket.TOPUP,
  CreditBucket.REWARD,
];

/**
 * Rate applied when a usage event names a model the catalog does not know —
 * one that has since been retired, or a gateway model dropped from config.
 * Deliberately Opus-priced so an unknown model is never billed too cheaply.
 */
const UNKNOWN_MODEL_RATES = { input: 2, output: 10 };

/** A single unit of metered consumption to persist. */
export interface RecordUsageInput {
  workspaceId: string;
  userId?: string | null;
  /** The scheduled task that spent the credits, when the run came from one. */
  taskId?: string | null;
  model: string;
  /** Input and output are billed at different rates, so they are kept apart. */
  inputTokens: number;
  outputTokens: number;
  /**
   * The cached slices of `inputTokens`, when the provider reports them. They do
   * not change what the workspace is charged — the caching saving is ours, not
   * theirs — only what the run is recorded as having cost us.
   */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** Web searches the run made, billed per search on top of its tokens. */
  webSearches?: number;
  /** What the images the run generated cost, in USD, billed on top of its tokens. */
  imageCostUsd?: number;
  /** Human label for what spent the credits, e.g. an app or feature name. */
  sourceName: string;
  type?: CreditEventType;
  /**
   * What the provider says the run cost us in USD. Omit when it reports nothing
   * and the cost will be derived from the model's list price instead.
   */
  providerCostUsd?: number;
  /** The backend that actually served a routed model id, when it reported one. */
  resolvedModel?: string | null;
}

/** A credit addition to persist on the grants ledger. */
export interface GrantCreditsInput {
  workspaceId: string;
  userId?: string | null;
  reason: CreditGrantReason;
  credits: number;
  /** Defaults to the bucket {@link bucketForReason} maps the reason to. */
  bucket?: CreditBucket;
  /** Omit for credits that never expire; required for PLAN and ROLLOVER. */
  expiresAt?: Date | null;
  amountCents?: number | null;
  currency?: string | null;
  stripeSessionId?: string | null;
  stripeInvoiceId?: string | null;
  note?: string | null;
}

/**
 * Where a grant lands when the caller does not say.
 *
 * Bought credits are TOPUP, a plan's allowance is PLAN, and everything given
 * away — trials, referrals, seat bonuses, support goodwill — is REWARD, which
 * is both never-expiring and last to be spent.
 */
export function bucketForReason(reason: CreditGrantReason): CreditBucket {
  switch (reason) {
    case CreditGrantReason.TOPUP:
      return CreditBucket.TOPUP;
    case CreditGrantReason.SUBSCRIPTION:
      return CreditBucket.PLAN;
    case CreditGrantReason.ROLLOVER:
      return CreditBucket.ROLLOVER;
    default:
      return CreditBucket.REWARD;
  }
}

/** A grant with credits still on it, as the spend planner needs to see it. */
export interface SpendableGrant {
  id: string;
  bucket: CreditBucket;
  remaining: number;
}

/** One grant's contribution to paying for a single run. */
export interface PlannedAllocation {
  grantId: string;
  bucket: CreditBucket;
  credits: number;
}

/**
 * Decide which grants pay for a run, in {@link SPEND_ORDER}.
 *
 * Pure and exported so the rule that governs every customer's balance can be
 * tested without a database — this is the one piece of the billing model where
 * an off-by-one silently moves money.
 *
 * Returns allocations totalling at most `credits`. A workspace holding less
 * than the run costs is drained to zero and the shortfall left unallocated:
 * the caller records the true charge either way, so the gap stays visible
 * rather than being written off.
 */
export function planAllocations(
  grants: readonly SpendableGrant[],
  credits: number,
): PlannedAllocation[] {
  const ordered = [...grants].sort(
    (a, b) => SPEND_ORDER.indexOf(a.bucket) - SPEND_ORDER.indexOf(b.bucket),
  );
  const out: PlannedAllocation[] = [];
  let outstanding = Math.max(0, credits);

  for (const grant of ordered) {
    if (outstanding <= 0) break;
    const take = Math.min(outstanding, grant.remaining);
    if (take <= 0) continue;
    out.push({ grantId: grant.id, bucket: grant.bucket, credits: take });
    outstanding -= take;
  }
  return out;
}

/**
 * A credit count as the dollar amount it represents, for grant notes and
 * receipts. Whole dollars where it divides evenly, because "$25" reads as a
 * price and "$25.00" reads as a line item.
 */
export function formatCredits(credits: number): string {
  const dollars = credits / CREDITS_PER_DOLLAR;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * An explicit, inclusive window to report over.
 *
 * Replaces the trailing day-count the endpoints used to take. A count can only
 * ever express "the last N days from now", which is exactly wrong for the two
 * calendar options the period dropdown offers: "Last month" became a 30-day
 * window overlapping the current one. The caller computes the boundaries and
 * sends them, because it is the only side that knows the viewer's timezone —
 * the Workspace entity has no timezone column, so the server picking "today"
 * would be guessing.
 */
export interface DateRange {
  from: Date;
  to: Date;
}

/** One row of the activity feed, with its user and task already resolved. */
export interface ActivityEntry {
  id: string;
  createdAt: Date;
  type: CreditEventType;
  sourceName: string;
  model: string;
  credits: number;
  tokens: number;
  user: { id: string; name: string; avatarUrl: string | null } | null;
  task: { id: string; name: string } | null;
}

/** A day in the usage series. Days with no events still appear, at zero. */
export interface DailyCreditPoint {
  day: string;
  thread: number;
  scheduledTask: number;
  credits: number;
}

/**
 * Pad a sparse series out to every day in the window.
 *
 * The group-by only returns days that saw events, so a quiet Sunday simply had
 * no row — and the chart then drew the following Monday in its place, silently
 * shifting every bar left and mislabelling the axis. Filling the gaps keeps one
 * bar per calendar day.
 */
function zeroFilledDays(rows: DailyCreditPoint[], range: DateRange): DailyCreditPoint[] {
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const out: DailyCreditPoint[] = [];
  // Buckets are UTC days, matching the date_trunc the group-by applies. A
  // range whose ends came from another timezone still lands on whole UTC days
  // here, so the series has one bar per bucket the query could have produced.
  const cursor = new Date(range.from);
  cursor.setUTCHours(0, 0, 0, 0);
  const last = new Date(range.to);
  last.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= last.getTime()) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? { day: key, thread: 0, scheduledTask: 0, credits: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

/** How spend with no user attached — rules, scheduled tasks — is labelled. */
export const SYSTEM_SPENDER_NAME = 'System (rules & tasks)';

/**
 * Credit accounting: meters consumption into the immutable credit_events
 * ledger and additions into credit_grants; a workspace's balance is the
 * difference between the two.
 */
@Injectable()
export class UsageService {
  constructor(
    @InjectRepository(CreditEvent)
    private readonly creditEventRepository: Repository<CreditEvent>,
    @InjectRepository(CreditGrant)
    private readonly creditGrantRepository: Repository<CreditGrant>,
    @InjectRepository(CreditAllocation)
    private readonly creditAllocationRepository: Repository<CreditAllocation>,
    @InjectRepository(ScheduledTask)
    private readonly scheduledTaskRepository: Repository<ScheduledTask>,
    private readonly configService: ConfigService<AppConfig, true>,
    private readonly usersService: UsersService,
  ) {}

  private definitionFor(model: string) {
    return buildCatalog(this.configService.get('ai', { infer: true }).gatewayModels).find(
      (candidate) => candidate.id === model,
    );
  }

  /** Credits charged for a run's tokens and web searches, minimum 1 per metered event. */
  private creditsFor(input: RecordUsageInput): number {
    const definition = this.definitionFor(input.model);
    const rates = definition ? creditRates(definition) : UNKNOWN_MODEL_RATES;
    const credits =
      (input.inputTokens / 1000) * rates.input +
      (input.outputTokens / 1000) * rates.output +
      webSearchCredits(input.webSearches ?? 0) +
      Math.max(0, input.imageCostUsd ?? 0) * CREDITS_PER_DOLLAR * CREDIT_MARGIN;
    return Math.max(1, Math.ceil(credits));
  }

  /**
   * What the run cost us, in USD. A provider-reported figure wins: for a routed
   * model id the catalog price is only a guess at which backend ran, while the
   * gateway knows. Falls back to list price, and to 0 for an unknown model —
   * recording nothing is better than inventing a number.
   */
  private costUsdFor(input: RecordUsageInput): number {
    // Images are paid to a separate provider, so no model provider's figure includes them.
    const images = Math.max(0, input.imageCostUsd ?? 0);
    if (input.providerCostUsd !== undefined && Number.isFinite(input.providerCostUsd)) {
      return input.providerCostUsd + images;
    }
    const definition = this.definitionFor(input.model);
    const extras = Math.max(0, input.webSearches ?? 0) * WEB_SEARCH_PRICE_USD + images;
    return definition
      ? listCostUsd(definition, input.inputTokens, input.outputTokens, {
          cacheWriteTokens: input.cacheWriteTokens,
          cacheReadTokens: input.cacheReadTokens,
        }) + extras
      : extras;
  }

  /**
   * Persist an immutable usage event and draw its cost from the workspace's
   * grants in expiry order.
   *
   * The event is the charge; the allocations are which credits paid it. Both
   * are written together so a run can never be metered without the balance
   * moving, or vice versa.
   */
  async recordEvent(input: RecordUsageInput): Promise<CreditEvent> {
    const event = this.creditEventRepository.create({
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      taskId: input.taskId ?? null,
      type: input.type ?? CreditEventType.THREAD,
      sourceName: input.sourceName,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      // Kept as the sum so the analytics queries below stay a single column read.
      tokensUsed: input.inputTokens + input.outputTokens,
      creditsUsed: this.creditsFor(input),
      model: input.model,
      resolvedModel: input.resolvedModel ?? null,
      // numeric columns round-trip as strings in pg; fix the scale here so the
      // stored value matches the column rather than relying on the driver.
      providerCostUsd: this.costUsdFor(input).toFixed(6),
    });
    const saved = await this.creditEventRepository.save(event);
    await this.allocate(saved);
    return saved;
  }

  /**
   * Spend `event.creditsUsed` across the workspace's live grants, soonest
   * expiry first, and record what came from where.
   *
   * A workspace that overdraws — the run costs more than it holds — is allowed
   * to finish: the allocations cover what existed and the event still records
   * the full charge, so the shortfall is visible as the gap between them rather
   * than silently written off. Cutting a reply off mid-sentence to save a
   * fraction of a cent is the worse trade.
   */
  private async allocate(event: CreditEvent): Promise<CreditAllocation[]> {
    const live = await this.liveGrantsForSpending(event.workspaceId);
    const planned = planAllocations(live, event.creditsUsed);
    if (planned.length === 0) return [];

    return this.creditAllocationRepository.save(
      planned.map((allocation) =>
        this.creditAllocationRepository.create({
          creditEventId: event.id,
          grantId: allocation.grantId,
          bucket: allocation.bucket,
          credits: allocation.credits,
        }),
      ),
    );
  }

  /**
   * Every unexpired grant with credits left on it, ordered the way spending
   * drains them: by bucket priority, then oldest first within a bucket so the
   * nearest expiry inside the same pot goes first.
   */
  private async liveGrantsForSpending(workspaceId: string): Promise<SpendableGrant[]> {
    const rows = await this.creditGrantRepository
      .createQueryBuilder(GRANT_ALIAS)
      .leftJoin(CreditAllocation, 'allocation', `allocation."grantId" = ${GRANT_ALIAS}.id`)
      .select(`${GRANT_ALIAS}.id`, 'id')
      .addSelect(`${GRANT_ALIAS}.bucket`, 'bucket')
      .addSelect(`${GRANT_ALIAS}.credits`, 'credits')
      .addSelect(`${GRANT_ALIAS}."expiresAt"`, 'expiresAt')
      .addSelect('COALESCE(SUM(allocation.credits), 0)', 'spent')
      .where(`${GRANT_ALIAS}."workspaceId" = :workspaceId`, { workspaceId })
      .andWhere(`(${GRANT_ALIAS}."expiresAt" IS NULL OR ${GRANT_ALIAS}."expiresAt" > NOW())`)
      .groupBy(`${GRANT_ALIAS}.id`)
      .having(`${GRANT_ALIAS}.credits > COALESCE(SUM(allocation.credits), 0)`)
      .orderBy(`${GRANT_ALIAS}."createdAt"`, 'ASC')
      .getRawMany<{
        id: string;
        bucket: CreditBucket;
        credits: number;
        expiresAt: Date | null;
        spent: string;
      }>();

    // Ordering across buckets is left to planAllocations; the SQL only has to
    // deliver oldest-first within each, which the ORDER BY above does.
    return rows.map((row) => ({
      id: row.id,
      bucket: row.bucket,
      remaining: Number(row.credits) - Number(row.spent),
    }));
  }

  /** Persist an immutable credit addition. */
  grantCredits(input: GrantCreditsInput): Promise<CreditGrant> {
    const grant = this.creditGrantRepository.create({
      workspaceId: input.workspaceId,
      userId: input.userId ?? null,
      reason: input.reason,
      bucket: input.bucket ?? bucketForReason(input.reason),
      credits: input.credits,
      expiresAt: input.expiresAt ?? null,
      amountCents: input.amountCents ?? null,
      currency: input.currency ?? null,
      stripeSessionId: input.stripeSessionId ?? null,
      stripeInvoiceId: input.stripeInvoiceId ?? null,
      note: input.note ?? null,
    });
    return this.creditGrantRepository.save(grant);
  }

  /**
   * Give a workspace its free trial credits, sized to the seats it has now.
   *
   * Safe to call on every workspace upsert: a workspace that already has an
   * onboarding grant (or was backfilled by migration) is left alone. The seat
   * count is read once, at first call — a team that grows later gets its extra
   * credits through the per-period seat bonus, not by re-running the trial.
   */
  async grantOnboardingCredits(workspaceId: string): Promise<CreditGrant | null> {
    const existing = await this.creditGrantRepository.findOne({
      where: { workspaceId, reason: CreditGrantReason.ONBOARDING },
    });
    if (existing) return null;

    const seats = Math.max(1, await this.usersService.countActiveByWorkspace(workspaceId));
    const credits = Math.max(TRIAL_CREDITS_FLOOR, seats * TRIAL_CREDITS_PER_SEAT);
    return this.grantCredits({
      workspaceId,
      reason: CreditGrantReason.ONBOARDING,
      credits,
      note: `Free trial — ${seats} seat${seats === 1 ? '' : 's'} (${formatCredits(credits)})`,
    });
  }

  /** Whether a Stripe Checkout session was already recorded (webhook retry). */
  async hasGrantForStripeSession(stripeSessionId: string): Promise<boolean> {
    const existing = await this.creditGrantRepository.findOne({ where: { stripeSessionId } });
    return Boolean(existing);
  }

  /**
   * The workspace's credit position, split by bucket.
   *
   * `balance` counts only live credits — an expired plan allowance is gone and
   * showing it as spendable would be a lie the checkout would then contradict.
   * What expired is reported alongside rather than folded into `used`, because
   * "you spent it" and "it ran out" are different answers to the same question.
   */
  async getBalance(workspaceId: string): Promise<CreditBalance> {
    const isDead = `${GRANT_ALIAS}."expiresAt" IS NOT NULL AND ${GRANT_ALIAS}."expiresAt" <= NOW()`;
    const remainingByGrant = this.creditGrantRepository
      .createQueryBuilder(GRANT_ALIAS)
      .leftJoin(CreditAllocation, 'allocation', `allocation."grantId" = ${GRANT_ALIAS}.id`)
      .select(`${GRANT_ALIAS}.bucket`, 'bucket')
      .addSelect(isDead, 'dead')
      .addSelect(`${GRANT_ALIAS}."expiresAt"`, 'expiresAt')
      .addSelect(`${GRANT_ALIAS}.credits`, 'granted')
      .addSelect('COALESCE(SUM(allocation.credits), 0)', 'spent')
      .where(`${GRANT_ALIAS}."workspaceId" = :workspaceId`, { workspaceId })
      // One row per grant, not per bucket. Grouping by bucket looks equivalent
      // and is not: the allocation join multiplies a grant's row by the number
      // of times it has been drawn on, so SUM(credits) counts a twice-spent
      // grant twice and the balance climbs as the workspace spends. Grouping by
      // the primary key keeps `credits` a single grant's figure; folding the
      // rows into buckets happens below, where the join cannot distort it.
      .groupBy(`${GRANT_ALIAS}.id`);

    const [rows, summary] = await Promise.all([
      remainingByGrant.getRawMany<{
        bucket: CreditBucket;
        dead: boolean;
        expiresAt: Date | null;
        granted: string;
        spent: string;
      }>(),
      this.summarizeForWorkspace(workspaceId),
    ]);

    let granted = 0;
    let expired = 0;
    const live = new Map<CreditBucket, BucketBalance>();

    for (const row of rows) {
      const rowGranted = Number(row.granted);
      const remaining = Math.max(0, rowGranted - Number(row.spent));
      granted += rowGranted;
      if (row.dead) {
        expired += remaining;
        continue;
      }
      const existing = live.get(row.bucket);
      const soonest =
        existing?.expiresAt && row.expiresAt
          ? new Date(Math.min(existing.expiresAt.getTime(), new Date(row.expiresAt).getTime()))
          : (existing?.expiresAt ?? (row.expiresAt ? new Date(row.expiresAt) : null));
      live.set(row.bucket, {
        bucket: row.bucket,
        credits: (existing?.credits ?? 0) + remaining,
        expiresAt: soonest,
      });
    }

    const buckets = SPEND_ORDER.map(
      (bucket) => live.get(bucket) ?? { bucket, credits: 0, expiresAt: null },
    );
    const balance = buckets.reduce((total, bucket) => total + bucket.credits, 0);

    return { granted, used: summary.totalCreditsUsed, balance, expired, buckets };
  }

  findGrantsForWorkspace(workspaceId: string, limit = 50): Promise<CreditGrant[]> {
    return this.creditGrantRepository.find({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  findRecentForWorkspace(workspaceId: string, limit = 50): Promise<CreditEvent[]> {
    return this.creditEventRepository.find({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Recent spend with the person and the task behind each row resolved.
   *
   * {@link findRecentForWorkspace} returns bare entities whose userId and
   * taskId are ids the page has no way to render, so the activity table would
   * have had to fetch every name and avatar itself, one request per row. The
   * relations are joined here instead.
   *
   * `taskId` narrows to a single task, which is what the Scheduled Tasks table
   * links into — the row and the filtered view then agree by construction,
   * because both are the same query.
   */
  async recentActivity(
    workspaceId: string,
    options: { taskId?: string; limit?: number } = {},
  ): Promise<ActivityEntry[]> {
    const events = await this.creditEventRepository.find({
      where: { workspaceId, ...(options.taskId ? { taskId: options.taskId } : {}) },
      relations: { user: true, task: true },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(options.limit ?? 50, 1), 200),
    });

    return events.map((event) => ({
      id: event.id,
      createdAt: event.createdAt,
      type: event.type,
      sourceName: event.sourceName,
      model: event.resolvedModel ?? event.model,
      credits: event.creditsUsed,
      tokens: event.tokensUsed,
      // Spend with no user attached is the schedulers acting for the
      // workspace, and is labelled the same way the leaderboard labels it.
      user: event.user
        ? {
            id: event.user.id,
            name: event.user.name || event.user.email || event.user.id,
            avatarUrl: event.user.avatarUrl,
          }
        : null,
      task: event.task ? { id: event.task.id, name: event.task.name } : null,
    }));
  }

  /**
   * A CreditEvent query already scoped to one workspace and one window.
   *
   * Every aggregate the Usage page renders needs exactly that pair, and each
   * one used to spell it out itself. Holding it in one place is what stops a
   * newly added aggregate from quietly reporting over a different window than
   * the rest of the response it ships in.
   */
  private scopedEvents(workspaceId: string, range: DateRange): SelectQueryBuilder<CreditEvent> {
    return this.creditEventRepository
      .createQueryBuilder('event')
      .where('event.workspaceId = :workspaceId', { workspaceId })
      .andWhere('event.createdAt >= :from', { from: range.from })
      .andWhere('event.createdAt <= :to', { to: range.to });
  }

  /** Credits/tokens per day over the window — the analytics chart. */
  async dailyUsage(
    workspaceId: string,
    range: DateRange,
  ): Promise<Array<{ day: string; credits: number; tokens: number; events: number }>> {
    const rows = await this.scopedEvents(workspaceId, range)
      .select(`to_char(event.createdAt, 'YYYY-MM-DD')`, 'day')
      .addSelect('SUM(event.creditsUsed)', 'credits')
      .addSelect('SUM(event.tokensUsed)', 'tokens')
      .addSelect('COUNT(event.id)', 'events')
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string; credits: string; tokens: string; events: string }>();
    return rows.map((row) => ({
      day: row.day,
      credits: Number(row.credits),
      tokens: Number(row.tokens),
      events: Number(row.events),
    }));
  }

  /** The workspace's heaviest credit spenders over the trailing window. */
  async topSpenders(
    workspaceId: string,
    range: DateRange,
    limit = 10,
  ): Promise<Array<{ userId: string | null; credits: number; events: number }>> {
    const rows = await this.scopedEvents(workspaceId, range)
      .select('event.userId', 'userId')
      .addSelect('SUM(event.creditsUsed)', 'credits')
      .addSelect('COUNT(event.id)', 'events')
      .groupBy('event.userId')
      .orderBy('credits', 'DESC')
      .limit(limit)
      .getRawMany<{ userId: string | null; credits: string; events: string }>();
    return rows.map((row) => ({
      userId: row.userId,
      credits: Number(row.credits),
      events: Number(row.events),
    }));
  }

  /**
   * Credits spent per scheduled task, richest first, with the task's own
   * details attached.
   *
   * The ScheduledTask entity is registered on this module directly rather than
   * importing TasksModule: that module pulls in AiModule, which imports this
   * one, so going through the service would close a dependency cycle.
   *
   * A task deleted since its runs were metered keeps its spend — the credits
   * were really spent — and is named as removed rather than dropped, so the
   * per-task figures still add up to the total.
   */
  async topTasks(workspaceId: string, range: DateRange, limit = 10) {
    const rows = await this.scopedEvents(workspaceId, range)
      .select('event.taskId', 'taskId')
      .addSelect('SUM(event.creditsUsed)', 'credits')
      .addSelect('COUNT(event.id)', 'runs')
      .addSelect('MAX(event.createdAt)', 'lastRun')
      .where('event.workspaceId = :workspaceId', { workspaceId })
      .andWhere('event.taskId IS NOT NULL')
      .groupBy('event.taskId')
      .orderBy('credits', 'DESC')
      .limit(limit)
      .getRawMany<{ taskId: string; credits: string; runs: string; lastRun: Date }>();
    if (!rows.length) return [];

    const tasks = await this.scheduledTaskRepository.find({
      where: { id: In(rows.map((row) => row.taskId)) },
    });
    const byId = new Map(tasks.map((task) => [task.id, task]));

    return rows.map((row) => {
      const task = byId.get(row.taskId);
      return {
        taskId: row.taskId,
        name: task?.name ?? 'Deleted task',
        createdByUserId: task?.createdByUserId ?? null,
        cronExpression: task?.cronExpression ?? null,
        isActive: task?.isActive ?? false,
        credits: Number(row.credits),
        runs: Number(row.runs),
        lastRun: row.lastRun ?? null,
      };
    });
  }

  /**
   * Daily credits split by what spent them, for the stacked usage chart.
   *
   * Separate from {@link dailyUsage} rather than replacing it: that one feeds
   * the admin tab and changing its shape would ripple there for no gain.
   */
  async dailyUsageSplit(
    workspaceId: string,
    range: DateRange,
  ): Promise<Array<{ day: string; thread: number; scheduledTask: number; credits: number }>> {
    const rows = await this.scopedEvents(workspaceId, range)
      .select(`to_char(date_trunc('day', event.createdAt), 'YYYY-MM-DD')`, 'day')
      .addSelect('event.type', 'type')
      .addSelect('SUM(event.creditsUsed)', 'credits')
      .groupBy('day')
      .addGroupBy('event.type')
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string; type: string; credits: string }>();

    const byDay = new Map<
      string,
      { day: string; thread: number; scheduledTask: number; credits: number }
    >();
    for (const row of rows) {
      const entry = byDay.get(row.day) ?? { day: row.day, thread: 0, scheduledTask: 0, credits: 0 };
      const credits = Number(row.credits);
      if (row.type === CreditEventType.SCHEDULED_TASK) entry.scheduledTask += credits;
      else entry.thread += credits;
      entry.credits += credits;
      byDay.set(row.day, entry);
    }
    return [...byDay.values()];
  }

  /**
   * Credits split by what spent them: interactive threads vs unattended runs.
   * Returned as raw totals; the caller decides how to present the proportion.
   */
  async creditsByType(
    workspaceId: string,
    range: DateRange,
  ): Promise<{ thread: number; scheduledTask: number }> {
    const rows = await this.scopedEvents(workspaceId, range)
      .select('event.type', 'type')
      .addSelect('SUM(event.creditsUsed)', 'credits')
      .groupBy('event.type')
      .getRawMany<{ type: string; credits: string }>();
    const creditsFor = (type: CreditEventType): number =>
      Number(rows.find((row) => row.type === type)?.credits ?? 0);
    return {
      thread: creditsFor(CreditEventType.THREAD),
      scheduledTask: creditsFor(CreditEventType.SCHEDULED_TASK),
    };
  }

  /**
   * The daily series plus the spender leaderboard, with user ids resolved to
   * names — everything the Usage page renders.
   *
   * Unattributed spend (a null userId) is work the schedulers did on the
   * workspace's behalf, not a person, and is labelled as such. Without that the
   * heaviest "user" on most workspaces is a blank row.
   *
   * AdminService.analytics builds the same shape for the admin tab; the two
   * should be folded together, but admin's is left alone here so this addition
   * cannot change a page that already works.
   */
  async analyticsForWorkspace(workspaceId: string, range: DateRange) {
    const [daily, spenders, members, byType, topTasks] = await Promise.all([
      this.dailyUsageSplit(workspaceId, range),
      this.topSpenders(workspaceId, range),
      this.usersService.listAllByWorkspace(workspaceId),
      this.creditsByType(workspaceId, range),
      this.topTasks(workspaceId, range),
    ]);
    const totalCredits = daily.reduce((sum, row) => sum + row.credits, 0);
    const series = zeroFilledDays(daily, range);
    const nameById = new Map(
      members.map((member) => [member.id, member.name ?? member.email ?? member.id]),
    );
    const avatarById = new Map(members.map((member) => [member.id, member.avatarUrl]));
    return {
      // Echoed back so the caller can label the chart with the window it
      // actually got, rather than the one it believes it asked for.
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      days: series.length,
      daily: series,
      totalCredits,
      // Burn is over the whole window, not just the days that saw traffic — a
      // quiet weekend is part of the rate, and averaging only active days would
      // overstate it. Series length is the day count, so an empty range cannot
      // divide by zero here.
      burnPerDay: series.length > 0 ? Math.round(totalCredits / series.length) : 0,
      byType,
      topTasks: topTasks.map((task) => ({
        ...task,
        createdByName: task.createdByUserId ? (nameById.get(task.createdByUserId) ?? null) : null,
      })),
      topSpenders: spenders.map((row) => ({
        ...row,
        name: row.userId ? (nameById.get(row.userId) ?? row.userId) : SYSTEM_SPENDER_NAME,
        avatarUrl: row.userId ? (avatarById.get(row.userId) ?? null) : null,
      })),
    };
  }

  /** Grants aggregated by reason — the revenue overview's headline numbers. */
  async grantTotalsByReason(
    workspaceId: string,
  ): Promise<Array<{ reason: string; credits: number; amountCents: number; count: number }>> {
    const rows = await this.creditGrantRepository
      .createQueryBuilder(GRANT_ALIAS)
      .select(`${GRANT_ALIAS}.reason`, 'reason')
      .addSelect(`SUM(${GRANT_ALIAS}.credits)`, 'credits')
      .addSelect(`COALESCE(SUM(${GRANT_ALIAS}.amountCents), 0)`, 'amount')
      .addSelect(`COUNT(${GRANT_ALIAS}.id)`, 'count')
      .where(`${GRANT_ALIAS}.workspaceId = :workspaceId`, { workspaceId })
      .groupBy(`${GRANT_ALIAS}.reason`)
      .getRawMany<{ reason: string; credits: string; amount: string; count: string }>();
    return rows.map((row) => ({
      reason: row.reason,
      credits: Number(row.credits),
      amountCents: Number(row.amount),
      count: Number(row.count),
    }));
  }

  /**
   * What the workspace's runs cost us against what it was charged for them —
   * the margin view. Credits are cents, so both sides are reported in USD to be
   * directly comparable. Scoped to a trailing window because the useful question
   * is "what is this costing now", not since the beginning of time.
   */
  async costSummary(
    workspaceId: string,
    range: DateRange,
  ): Promise<{
    costUsd: number;
    chargedUsd: number;
    marginUsd: number;
    tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
    events: number;
  }> {
    const row = await this.scopedEvents(workspaceId, range)
      .select('COALESCE(SUM(event.providerCostUsd), 0)', 'cost')
      .addSelect('COALESCE(SUM(event.creditsUsed), 0)', 'credits')
      .addSelect('COALESCE(SUM(event.inputTokens), 0)', 'input')
      .addSelect('COALESCE(SUM(event.outputTokens), 0)', 'output')
      .addSelect('COALESCE(SUM(event.cacheWriteTokens), 0)', 'cacheWrite')
      .addSelect('COALESCE(SUM(event.cacheReadTokens), 0)', 'cacheRead')
      .addSelect('COUNT(event.id)', 'events')
      .getRawOne<Record<string, string>>();

    const costUsd = Number(row?.cost ?? 0);
    const chargedUsd = Number(row?.credits ?? 0) / CREDITS_PER_DOLLAR;
    return {
      costUsd,
      chargedUsd,
      marginUsd: chargedUsd - costUsd,
      tokens: {
        input: Number(row?.input ?? 0),
        output: Number(row?.output ?? 0),
        cacheWrite: Number(row?.cacheWrite ?? 0),
        cacheRead: Number(row?.cacheRead ?? 0),
      },
      events: Number(row?.events ?? 0),
    };
  }

  async summarizeForWorkspace(workspaceId: string): Promise<UsageSummary> {
    const { credits, tokens, count } = await this.creditEventRepository
      .createQueryBuilder('event')
      .select('COALESCE(SUM(event.creditsUsed), 0)', 'credits')
      .addSelect('COALESCE(SUM(event.tokensUsed), 0)', 'tokens')
      .addSelect('COUNT(event.id)', 'count')
      .where('event.workspaceId = :workspaceId', { workspaceId })
      .getRawOne<{ credits: string; tokens: string; count: string }>()
      .then((raw) => raw ?? { credits: '0', tokens: '0', count: '0' });

    return {
      totalCreditsUsed: Number(credits),
      totalTokensUsed: Number(tokens),
      eventCount: Number(count),
    };
  }
}
