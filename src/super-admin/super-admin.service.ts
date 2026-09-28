import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { CREDITS_PER_DOLLAR } from '../ai/providers/model-catalog';
import { BugReportStatus, SubscriptionStatus, UserRole } from '../common/enums';
import {
  BugReport,
  CreditEvent,
  CreditGrant,
  Integration,
  Subscription,
  User,
  Workspace,
} from '../database/entities';
import { DateRange, GRANT_ALIAS, UsageService } from '../usage/usage.service';
import { UsersService } from '../users/users.service';
import {
  ACTIVE_TRIAL_DAYS,
  SUBSCRIBED_STATUSES,
  StageCountRow,
  WORKSPACE_STAGES,
  WorkspaceStage,
  summarizeSales,
} from './sales';

/**
 * Query-builder alias for `users`, deliberately not `user`.
 *
 * The same trap {@link GRANT_ALIAS} exists to avoid, on a different reserved
 * word. USER is a reserved niladic function in Postgres — bare `user` evaluates
 * to the session user — so `user."isActive"` is a syntax error.
 *
 * TypeORM hides this for the `alias.property` form, which it rewrites into
 * `"alias"."column"`, quoting as it goes. A raw fragment that already names the
 * column — the `FILTER (WHERE ...)` clauses below — does not match that pattern
 * and is passed through verbatim, alias unquoted, so it compiles fine and dies
 * at runtime. Naming the alias something unreserved makes both forms safe.
 */
const USER_ALIAS = 'member';

/**
 * How the customer table may be ordered.
 *
 * Deliberately short. Two of these — headcount and last activity — are
 * aggregates rather than columns, and each one costs a grouped subquery in the
 * driver below, so the list is the questions worth a join rather than every
 * field that happens to be displayed.
 */
export type WorkspaceSort = 'created' | 'members' | 'activity' | 'name';

const WORKSPACE_SORTS: readonly WorkspaceSort[] = ['created', 'members', 'activity', 'name'];

/** The cutoff a trial must have run something after to count as active. */
function activeTrialSince(): Date {
  return new Date(Date.now() - ACTIVE_TRIAL_DAYS * 86_400_000);
}

/**
 * Credits granted, cash paid, and credits still live — one row per workspace.
 *
 * Builds onto a bare query builder so the same totals can be read directly or
 * joined in as a subquery (the sales stage needs "has paid" and "has credits
 * left" for every workspace at once).
 *
 * The allocation totals are folded to one row per grant *inside a subquery*
 * before the join, which is the whole trick. Joining `credit_allocations`
 * directly multiplies a grant's row by the number of times it has been drawn
 * on, so `SUM(credits)` counts a twice-spent grant twice and a workspace's
 * granted total climbs as it spends. That exact bug shipped once on the
 * single-workspace balance query (see `UsageService.getBalance`); the
 * pre-aggregated join makes it unrepresentable here.
 *
 * `live` counts only unexpired grants, matching what `getBalance` calls
 * spendable, so a workspace's row and its drill-in never disagree.
 */
function grantTotalsQuery<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  workspaceIds?: string[],
): SelectQueryBuilder<T> {
  qb.from(CreditGrant, GRANT_ALIAS)
    .leftJoin(
      (sub) =>
        sub
          .select('allocation."grantId"', 'grantId')
          .addSelect('SUM(allocation.credits)', 'spent')
          .from('credit_allocations', 'allocation')
          .groupBy('allocation."grantId"'),
      'spend',
      `spend."grantId" = ${GRANT_ALIAS}.id`,
    )
    .select(`${GRANT_ALIAS}."workspaceId"`, 'workspaceId')
    .addSelect(`COALESCE(SUM(${GRANT_ALIAS}.credits), 0)`, 'granted')
    .addSelect(`COALESCE(SUM(${GRANT_ALIAS}."amountCents"), 0)`, 'paid')
    .addSelect(
      `COALESCE(SUM(
        CASE WHEN ${GRANT_ALIAS}."expiresAt" IS NULL OR ${GRANT_ALIAS}."expiresAt" > NOW()
             THEN GREATEST(${GRANT_ALIAS}.credits - COALESCE(spend.spent, 0), 0)
             ELSE 0 END
      ), 0)`,
      'live',
    )
    .groupBy(`${GRANT_ALIAS}."workspaceId"`);
  if (workspaceIds) {
    qb.where(`${GRANT_ALIAS}."workspaceId" IN (:...workspaceIds)`, { workspaceIds });
  }
  return qb;
}

/**
 * Each workspace's sales stage (see {@link WorkspaceStage}), with its plan.
 *
 * The one definition of the funnel. The overview groups over it, the customer
 * table filters on it, and each row carries it — all from this query, so the
 * "3 active trials" on the overview is always the three rows the filter shows.
 *
 * Order in the CASE is precedence: a live plan outranks everything, a cancelled
 * plan outranks later top-ups (losing a subscriber is the fact worth seeing),
 * and only a workspace that has never paid is any kind of trial.
 */
function stageQuery<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  activeSince: Date,
  workspaceIds?: string[],
): SelectQueryBuilder<T> {
  qb.select('workspace.id', 'workspaceId')
    .addSelect('subscription."planId"', 'planId')
    .addSelect('subscription.status', 'status')
    .addSelect('COALESCE(subscription."cancelAtPeriodEnd", false)', 'cancelling')
    .addSelect(
      `CASE
        WHEN subscription.status IN (:...subscribedStatuses) THEN 'subscribed'
        WHEN subscription.status = :canceledStatus THEN 'canceled'
        WHEN COALESCE(money.paid, 0) > 0 THEN 'topup_only'
        WHEN COALESCE(money.live, 0) <= 0 THEN 'trial_spent'
        WHEN runs.seen >= :activeSince THEN 'trial_active'
        ELSE 'trial_idle'
      END`,
      'stage',
    )
    .from(Workspace, 'workspace')
    .leftJoin(Subscription, 'subscription', 'subscription."workspaceId" = workspace.id')
    .leftJoin(
      (sub) => grantTotalsQuery(sub, workspaceIds),
      'money',
      'money."workspaceId" = workspace.id',
    )
    .leftJoin(
      (sub) => {
        sub
          .select('run."workspaceId"', 'workspaceId')
          .addSelect('MAX(run."createdAt")', 'seen')
          .from(CreditEvent, 'run')
          .groupBy('run."workspaceId"');
        if (workspaceIds) {
          sub.where('run."workspaceId" IN (:...workspaceIds)', { workspaceIds });
        }
        return sub;
      },
      'runs',
      'runs."workspaceId" = workspace.id',
    )
    .setParameters({
      subscribedStatuses: [...SUBSCRIBED_STATUSES],
      canceledStatus: SubscriptionStatus.CANCELED,
      activeSince,
    });
  if (workspaceIds) {
    qb.andWhere('workspace.id IN (:...workspaceIds)', { workspaceIds });
  }
  return qb;
}

/** One tenant on the owner panel's workspace table. */
export interface PlatformWorkspaceRow {
  id: string;
  name: string;
  slackTeamId: string;
  createdAt: Date;
  members: { total: number; active: number; admins: number };
  credits: { granted: number; used: number; balance: number };
  /** Cash actually taken for this workspace, in cents. */
  paidCents: number;
  plan: { planId: string; status: string; seats: number; currentPeriodEnd: Date } | null;
  /** Where this workspace sits in the sales funnel. */
  stage: WorkspaceStage;
  connectedAccounts: number;
  lastActivityAt: Date | null;
}

/** The per-workspace aggregates, keyed by workspace id, that the table merges. */
interface WorkspaceAggregates {
  members: Map<string, { total: number; active: number; admins: number }>;
  credits: Map<string, { granted: number; used: number; balance: number; paidCents: number }>;
  integrations: Map<string, number>;
  activity: Map<string, Date>;
  plans: Map<string, Subscription>;
  stages: Map<string, WorkspaceStage>;
}

/**
 * The read model behind the platform owner's panel.
 *
 * Every other service in this app is tenant-scoped by construction — the README
 * calls it the security posture, and `AdminService` right next door takes a
 * `workspaceId` on every method. This one is the deliberate exception, and the
 * only one: it answers questions about the business rather than about a
 * customer. It is reachable exclusively through {@link SuperAdminGuard}.
 *
 * The queries here are grouped rather than looped. `scripts/grant-credits.ts`
 * does the same job by listing workspaces and calling `getBalance()` on each,
 * which is fine for a CLI run once by hand and quadratic on a page that loads
 * every time the owner opens a tab.
 */
@Injectable()
export class SuperAdminService {
  constructor(
    @InjectRepository(Workspace)
    private readonly workspaceRepository: Repository<Workspace>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(CreditEvent)
    private readonly creditEventRepository: Repository<CreditEvent>,
    @InjectRepository(CreditGrant)
    private readonly creditGrantRepository: Repository<CreditGrant>,
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(Integration)
    private readonly integrationRepository: Repository<Integration>,
    @InjectRepository(BugReport)
    private readonly bugReportRepository: Repository<BugReport>,
    private readonly usageService: UsageService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Credits still live, spent, and granted — per workspace, in one query. The
   * grant side is {@link grantTotalsQuery}, which explains why it is shaped as it is.
   */
  private async creditsByWorkspace(
    workspaceIds: string[],
  ): Promise<Map<string, { granted: number; used: number; balance: number; paidCents: number }>> {
    const out = new Map<
      string,
      { granted: number; used: number; balance: number; paidCents: number }
    >();
    if (workspaceIds.length === 0) return out;

    const grantRows = await grantTotalsQuery(
      this.creditGrantRepository.manager.createQueryBuilder(),
      workspaceIds,
    ).getRawMany<{ workspaceId: string; granted: string; paid: string; live: string }>();

    const usedRows = await this.creditEventRepository
      .createQueryBuilder('event')
      .select('event."workspaceId"', 'workspaceId')
      .addSelect('COALESCE(SUM(event."creditsUsed"), 0)', 'used')
      .where('event."workspaceId" IN (:...workspaceIds)', { workspaceIds })
      .groupBy('event."workspaceId"')
      .getRawMany<{ workspaceId: string; used: string }>();

    const usedById = new Map(usedRows.map((row) => [row.workspaceId, Number(row.used)]));
    for (const id of workspaceIds) {
      const grants = grantRows.find((row) => row.workspaceId === id);
      out.set(id, {
        granted: Number(grants?.granted ?? 0),
        balance: Number(grants?.live ?? 0),
        paidCents: Number(grants?.paid ?? 0),
        used: usedById.get(id) ?? 0,
      });
    }
    return out;
  }

  /** Every per-workspace aggregate the table needs, fetched side by side. */
  private async aggregatesFor(workspaceIds: string[]): Promise<WorkspaceAggregates> {
    const empty: WorkspaceAggregates = {
      members: new Map(),
      credits: new Map(),
      integrations: new Map(),
      activity: new Map(),
      plans: new Map(),
      stages: new Map(),
    };
    if (workspaceIds.length === 0) return empty;

    const [memberRows, credits, integrationRows, activityRows, subscriptions, stageRows] =
      await Promise.all([
        this.userRepository
          .createQueryBuilder(USER_ALIAS)
          .select(`${USER_ALIAS}."workspaceId"`, 'workspaceId')
          .addSelect(`COUNT(${USER_ALIAS}.id)`, 'total')
          .addSelect(`COUNT(${USER_ALIAS}.id) FILTER (WHERE ${USER_ALIAS}."isActive")`, 'active')
          .addSelect(
            `COUNT(${USER_ALIAS}.id) FILTER (WHERE ${USER_ALIAS}.role = :adminRole)`,
            'admins',
          )
          .where(`${USER_ALIAS}."workspaceId" IN (:...workspaceIds)`, { workspaceIds })
          .setParameter('adminRole', UserRole.ADMIN)
          .groupBy(`${USER_ALIAS}."workspaceId"`)
          .getRawMany<{ workspaceId: string; total: string; active: string; admins: string }>(),
        this.creditsByWorkspace(workspaceIds),
        this.integrationRepository
          .createQueryBuilder('integration')
          .select('integration."workspaceId"', 'workspaceId')
          .addSelect('COUNT(integration.id)', 'count')
          .where('integration."workspaceId" IN (:...workspaceIds)', { workspaceIds })
          .andWhere('integration."isActive"')
          .groupBy('integration."workspaceId"')
          .getRawMany<{ workspaceId: string; count: string }>(),
        this.creditEventRepository
          .createQueryBuilder('event')
          .select('event."workspaceId"', 'workspaceId')
          .addSelect('MAX(event."createdAt")', 'lastActivityAt')
          .where('event."workspaceId" IN (:...workspaceIds)', { workspaceIds })
          .groupBy('event."workspaceId"')
          .getRawMany<{ workspaceId: string; lastActivityAt: Date }>(),
        this.subscriptionRepository
          .createQueryBuilder('subscription')
          .where('subscription."workspaceId" IN (:...workspaceIds)', { workspaceIds })
          .getMany(),
        // Re-reads credits and activity the queries above already have, rather
        // than deriving the stage from them in JavaScript: a second copy of the
        // rule here would be free to drift from the SQL the overview counts with.
        stageQuery(
          this.workspaceRepository.manager.createQueryBuilder(),
          activeTrialSince(),
          workspaceIds,
        ).getRawMany<{ workspaceId: string; stage: WorkspaceStage }>(),
      ]);

    return {
      members: new Map(
        memberRows.map((row) => [
          row.workspaceId,
          { total: Number(row.total), active: Number(row.active), admins: Number(row.admins) },
        ]),
      ),
      credits,
      integrations: new Map(integrationRows.map((row) => [row.workspaceId, Number(row.count)])),
      activity: new Map(activityRows.map((row) => [row.workspaceId, row.lastActivityAt])),
      plans: new Map(subscriptions.map((row) => [row.workspaceId, row])),
      stages: new Map(stageRows.map((row) => [row.workspaceId, row.stage])),
    };
  }

  /** Turn a workspace plus its aggregates into a table row. */
  private toWorkspaceRow(
    workspace: Workspace,
    aggregates: WorkspaceAggregates,
  ): PlatformWorkspaceRow {
    const credits = aggregates.credits.get(workspace.id);
    const plan = aggregates.plans.get(workspace.id);
    return {
      id: workspace.id,
      name: workspace.name,
      slackTeamId: workspace.slackTeamId,
      createdAt: workspace.createdAt,
      members: aggregates.members.get(workspace.id) ?? { total: 0, active: 0, admins: 0 },
      credits: {
        granted: credits?.granted ?? 0,
        used: credits?.used ?? 0,
        balance: credits?.balance ?? 0,
      },
      paidCents: credits?.paidCents ?? 0,
      plan: plan
        ? {
            planId: plan.planId,
            status: plan.status,
            seats: plan.seats,
            currentPeriodEnd: plan.currentPeriodEnd,
          }
        : null,
      // Every workspace has a stage row; the fallback is only for one created
      // between the page query and this one.
      stage: aggregates.stages.get(workspace.id) ?? 'trial_idle',
      connectedAccounts: aggregates.integrations.get(workspace.id) ?? 0,
      lastActivityAt: aggregates.activity.get(workspace.id) ?? null,
    };
  }

  /**
   * The customer table: every workspace with its numbers, in the asked order.
   *
   * Paged rather than "all of them" — the aggregate queries take an id list, so
   * the page size bounds the work regardless of how many tenants exist.
   *
   * Ordering runs in two steps because two of the sort keys are aggregates, and
   * an aggregate cannot be paged after the fact: taking the first 50 workspaces
   * and *then* counting their members sorts one arbitrary page rather than the
   * platform. So a driver query resolves id order and the page window in the
   * database, and the row bodies are loaded from those ids. The joins it needs
   * for that are grouped subqueries, not direct joins, for the reason
   * {@link creditsByWorkspace} spells out: joining `users` and `credit_events`
   * to `workspaces` at once multiplies every member by every run.
   */
  async listWorkspaces(
    options: {
      search?: string;
      limit?: number;
      offset?: number;
      sort?: WorkspaceSort;
      stage?: WorkspaceStage;
    } = {},
  ): Promise<{
    total: number;
    rows: PlatformWorkspaceRow[];
    sort: WorkspaceSort;
    stage: WorkspaceStage | null;
  }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);
    const sort: WorkspaceSort = WORKSPACE_SORTS.includes(options.sort as WorkspaceSort)
      ? (options.sort as WorkspaceSort)
      : 'created';
    const stage = WORKSPACE_STAGES.includes(options.stage as WorkspaceStage)
      ? (options.stage as WorkspaceStage)
      : null;
    const search = options.search?.trim();

    // Matched on the two identifiers the owner actually has to hand when
    // someone emails in: what the workspace is called, and its Slack team id.
    const searchClause = '(workspace.name ILIKE :search OR workspace."slackTeamId" ILIKE :search)';
    const searchParams = { search: `%${search ?? ''}%` };

    const driver = this.workspaceRepository
      .createQueryBuilder('workspace')
      .select('workspace.id', 'id')
      .addSelect('workspace.name', 'name')
      .addSelect('workspace."createdAt"', 'created')
      .limit(limit)
      .offset(offset);

    // Joined only when they are what we are ordering by. The page's own
    // headcount and activity numbers come from aggregatesFor(), scoped to the
    // ids; these subqueries scan the whole table, so they are not worth paying
    // for on a sort that does not read them.
    if (sort === 'members') {
      driver
        .leftJoin(
          (sub) =>
            sub
              .select(`${USER_ALIAS}."workspaceId"`, 'workspaceId')
              .addSelect(`COUNT(${USER_ALIAS}.id)`, 'headcount')
              .from(User, USER_ALIAS)
              .groupBy(`${USER_ALIAS}."workspaceId"`),
          'roster',
          'roster."workspaceId" = workspace.id',
        )
        .addSelect('COALESCE(roster.headcount, 0)', 'members')
        .orderBy('members', 'DESC');
    } else if (sort === 'activity') {
      driver
        .leftJoin(
          (sub) =>
            sub
              .select('run."workspaceId"', 'workspaceId')
              .addSelect('MAX(run."createdAt")', 'seen')
              .from(CreditEvent, 'run')
              .groupBy('run."workspaceId"'),
          'runs',
          'runs."workspaceId" = workspace.id',
        )
        .addSelect('runs.seen', 'activity')
        // A workspace that has never run anything sorts last rather than first:
        // NULL is "no activity", not "infinitely recent".
        .orderBy('activity', 'DESC', 'NULLS LAST');
    } else if (sort === 'name') {
      driver.orderBy('LOWER(workspace.name)', 'ASC');
    } else {
      driver.orderBy('created', 'DESC');
    }

    const counter = this.workspaceRepository.createQueryBuilder('workspace');
    if (search) {
      driver.andWhere(searchClause, searchParams);
      counter.andWhere(searchClause, searchParams);
    }
    if (stage) {
      const activeSince = activeTrialSince();
      for (const query of [driver, counter]) {
        query
          .innerJoin(
            (sub) => stageQuery(sub, activeSince),
            'stages',
            'stages."workspaceId" = workspace.id',
          )
          .andWhere('stages.stage = :stage', { stage });
      }
    }

    const [ordered, total] = await Promise.all([
      driver.getRawMany<{ id: string }>(),
      counter.getCount(),
    ]);

    const ids = ordered.map((row) => row.id);
    if (ids.length === 0) return { total, rows: [], sort, stage };

    const [workspaces, aggregates] = await Promise.all([
      this.workspaceRepository.find({ where: { id: In(ids) } }),
      this.aggregatesFor(ids),
    ]);

    // find() returns rows in whatever order Postgres hands them back, so the
    // driver's ordering is re-imposed here rather than assumed.
    const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const rows = ids
      .map((id) => byId.get(id))
      .filter((workspace): workspace is Workspace => workspace !== undefined)
      .map((workspace) => this.toWorkspaceRow(workspace, aggregates));

    return { total, rows, sort, stage };
  }

  /**
   * Everything about one customer, on one screen.
   *
   * Reuses the tenant-scoped services wholesale — this is the one place where
   * the N+1 the list view avoids is correct, because N is one.
   */
  async workspaceDetail(workspaceId: string) {
    const workspace = await this.workspaceRepository.findOne({ where: { id: workspaceId } });
    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    const to = new Date();
    const range: DateRange = { from: new Date(to.getTime() - 30 * 86_400_000), to };

    const [members, balance, usage, grants, subscription, integrations, cost, activity, bugs] =
      await Promise.all([
        this.usersService.listAllByWorkspace(workspaceId),
        this.usageService.getBalance(workspaceId),
        this.usageService.summarizeForWorkspace(workspaceId),
        this.usageService.findGrantsForWorkspace(workspaceId),
        this.subscriptionRepository.findOne({ where: { workspaceId } }),
        this.integrationRepository.find({ where: { workspaceId, isActive: true } }),
        this.usageService.costSummary(workspaceId, range),
        this.usageService.recentActivity(workspaceId, { limit: 25 }),
        this.bugReportRepository.count({ where: { workspaceId } }),
      ]);

    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slackTeamId: workspace.slackTeamId,
        defaultModel: workspace.defaultModel,
        createdAt: workspace.createdAt,
      },
      members: members.map((member) => ({
        id: member.id,
        name: member.name,
        email: member.email,
        avatarUrl: member.avatarUrl,
        role: member.role,
        isActive: member.isActive,
        lastActiveAt: member.lastActiveAt,
        createdAt: member.createdAt,
      })),
      credits: balance,
      usage,
      // 30 days of margin, so the drill-in answers "is this customer profitable"
      // and not just "how much have they spent".
      cost,
      subscription,
      grants,
      integrations: integrations.map((integration) => ({
        id: integration.id,
        provider: integration.provider,
        appSlug: integration.appSlug,
        accountName: integration.accountName,
        accessLevel: integration.accessLevel,
        createdAt: integration.createdAt,
      })),
      recentActivity: activity,
      bugReportCount: bugs,
    };
  }

  /**
   * The shape of the customer base by headcount, in one round trip.
   *
   * "How many workspaces, with how many people in them" is two different
   * questions and the averages answer neither on their own: ten solo Slacks and
   * one fifty-person company average out to a healthy-looking team size that
   * describes nobody. So this returns the spread — the median next to the mean,
   * and a bucketed distribution — rather than a single number.
   *
   * The per-workspace counts are folded to one row inside the subquery, so the
   * database returns exactly one row however many tenants exist. Counting in
   * JavaScript instead would mean shipping a row per workspace to compute four
   * totals.
   */
  private async teamSizes() {
    const row = await this.workspaceRepository.manager
      .createQueryBuilder()
      .select('COUNT(sizes.id)', 'workspaces')
      .addSelect('COALESCE(SUM(sizes.members), 0)', 'people')
      .addSelect('COALESCE(SUM(sizes.active), 0)', 'activePeople')
      .addSelect('COALESCE(AVG(sizes.members), 0)', 'mean')
      .addSelect(
        'COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY sizes.members), 0)',
        'median',
      )
      .addSelect('COALESCE(MAX(sizes.members), 0)', 'largest')
      .addSelect('COUNT(sizes.id) FILTER (WHERE sizes.members <= 1)', 'solo')
      .addSelect('COUNT(sizes.id) FILTER (WHERE sizes.members BETWEEN 2 AND 5)', 'small')
      .addSelect('COUNT(sizes.id) FILTER (WHERE sizes.members BETWEEN 6 AND 20)', 'medium')
      .addSelect('COUNT(sizes.id) FILTER (WHERE sizes.members > 20)', 'large')
      .from(
        (sub) =>
          sub
            .select('workspace.id', 'id')
            .addSelect(`COUNT(${USER_ALIAS}.id)`, 'members')
            .addSelect(`COUNT(${USER_ALIAS}.id) FILTER (WHERE ${USER_ALIAS}."isActive")`, 'active')
            .from(Workspace, 'workspace')
            // LEFT, so a workspace whose members have all been removed still
            // counts as a workspace — at zero, in the solo bucket.
            .leftJoin(User, USER_ALIAS, `${USER_ALIAS}."workspaceId" = workspace.id`)
            .groupBy('workspace.id'),
        'sizes',
      )
      .getRawOne<Record<string, string>>();

    return {
      people: Number(row?.people ?? 0),
      activePeople: Number(row?.activePeople ?? 0),
      meanTeamSize: Number(row?.mean ?? 0),
      medianTeamSize: Number(row?.median ?? 0),
      largestTeam: Number(row?.largest ?? 0),
      distribution: {
        solo: Number(row?.solo ?? 0),
        small: Number(row?.small ?? 0),
        medium: Number(row?.medium ?? 0),
        large: Number(row?.large ?? 0),
      },
    };
  }

  /**
   * Platform headline numbers.
   *
   * Revenue is the sum of `credit_grants.amountCents`, which is what was
   * actually collected and recorded — Stripe remains the source of truth for
   * money, and this figure is a ledger read, not an invoice total. Cost and
   * margin come from the same window so the three can be read together.
   */
  async overview(days = 30) {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);

    const [
      workspaceCount,
      newWorkspaces,
      userCounts,
      grantTotals,
      windowGrants,
      eventTotals,
      windowEvents,
      bugCounts,
      teams,
      activeWorkspaces,
      stageRows,
    ] = await Promise.all([
      this.workspaceRepository.count(),
      this.workspaceRepository
        .createQueryBuilder('workspace')
        .where('workspace."createdAt" >= :from', { from })
        .getCount(),
      this.userRepository
        .createQueryBuilder(USER_ALIAS)
        .select(`COUNT(${USER_ALIAS}.id)`, 'total')
        .addSelect(`COUNT(${USER_ALIAS}.id) FILTER (WHERE ${USER_ALIAS}."isActive")`, 'active')
        .addSelect(
          `COUNT(${USER_ALIAS}.id) FILTER (WHERE ${USER_ALIAS}."lastActiveAt" >= :from)`,
          'activeInWindow',
        )
        .addSelect(`COUNT(${USER_ALIAS}.id) FILTER (WHERE ${USER_ALIAS}.role = :adminRole)`, 'admins')
        .setParameters({ from, adminRole: UserRole.ADMIN })
        .getRawOne<Record<string, string>>(),
      this.creditGrantRepository
        .createQueryBuilder(GRANT_ALIAS)
        .select(`COALESCE(SUM(${GRANT_ALIAS}.credits), 0)`, 'credits')
        .addSelect(`COALESCE(SUM(${GRANT_ALIAS}."amountCents"), 0)`, 'paid')
        .getRawOne<Record<string, string>>(),
      this.creditGrantRepository
        .createQueryBuilder(GRANT_ALIAS)
        .select(`COALESCE(SUM(${GRANT_ALIAS}."amountCents"), 0)`, 'paid')
        .where(`${GRANT_ALIAS}."createdAt" >= :from`, { from })
        .getRawOne<Record<string, string>>(),
      this.creditEventRepository
        .createQueryBuilder('event')
        .select('COALESCE(SUM(event."creditsUsed"), 0)', 'credits')
        .addSelect('COALESCE(SUM(event."providerCostUsd"), 0)', 'cost')
        .addSelect('COUNT(event.id)', 'events')
        .getRawOne<Record<string, string>>(),
      this.creditEventRepository
        .createQueryBuilder('event')
        .select('COALESCE(SUM(event."creditsUsed"), 0)', 'credits')
        .addSelect('COALESCE(SUM(event."providerCostUsd"), 0)', 'cost')
        .addSelect('COUNT(event.id)', 'events')
        .where('event."createdAt" >= :from', { from })
        .getRawOne<Record<string, string>>(),
      this.bugReportRepository
        .createQueryBuilder('bug')
        .select('bug.status', 'status')
        .addSelect('COUNT(bug.id)', 'count')
        .groupBy('bug.status')
        .getRawMany<{ status: BugReportStatus; count: string }>(),
      this.teamSizes(),
      // Distinct tenants that ran anything in the window — the denominator for
      // "are these workspaces customers or just signups".
      this.creditEventRepository
        .createQueryBuilder('event')
        .select('COUNT(DISTINCT event."workspaceId")', 'count')
        .where('event."createdAt" >= :from', { from })
        .getRawOne<{ count: string }>(),
      // The funnel, grouped by plan so MRR can be priced off the ladder. Its
      // trial window is fixed rather than following `days`: the customer
      // table's stage filter has no window, and the two must count alike.
      this.workspaceRepository.manager
        .createQueryBuilder()
        .select('stages.stage', 'stage')
        .addSelect('stages."planId"', 'planId')
        .addSelect('COUNT(*)', 'count')
        .addSelect('COUNT(*) FILTER (WHERE stages.status = :pastDueStatus)', 'pastDue')
        .addSelect('COUNT(*) FILTER (WHERE stages.cancelling)', 'cancelling')
        .from((sub) => stageQuery(sub, activeTrialSince()), 'stages')
        .setParameter('pastDueStatus', SubscriptionStatus.PAST_DUE)
        .groupBy('stages.stage')
        .addGroupBy('stages."planId"')
        .getRawMany<Record<keyof StageCountRow, string | null>>(),
    ]);

    const windowChargedUsd = Number(windowEvents?.credits ?? 0) / CREDITS_PER_DOLLAR;
    const windowCostUsd = Number(windowEvents?.cost ?? 0);

    return {
      days,
      range: { from: from.toISOString(), to: to.toISOString() },
      workspaces: {
        total: workspaceCount,
        newInWindow: newWorkspaces,
        activeInWindow: Number(activeWorkspaces?.count ?? 0),
        // Signed up, never ran anything in the window. Not the same as churned —
        // a workspace that ran nothing this month still has its credits.
        idleInWindow: Math.max(workspaceCount - Number(activeWorkspaces?.count ?? 0), 0),
      },
      users: {
        total: Number(userCounts?.total ?? 0),
        active: Number(userCounts?.active ?? 0),
        activeInWindow: Number(userCounts?.activeInWindow ?? 0),
        admins: Number(userCounts?.admins ?? 0),
      },
      // How the headcount is spread across tenants, not just its total.
      teams,
      revenue: {
        totalCents: Number(grantTotals?.paid ?? 0),
        windowCents: Number(windowGrants?.paid ?? 0),
      },
      // Paying customers, trials and MRR — the sales view of the same tenants.
      sales: summarizeSales(
        stageRows.map((row) => ({
          stage: row.stage as WorkspaceStage,
          planId: row.planId,
          count: Number(row.count ?? 0),
          pastDue: Number(row.pastDue ?? 0),
          cancelling: Number(row.cancelling ?? 0),
        })),
      ),
      credits: {
        granted: Number(grantTotals?.credits ?? 0),
        used: Number(eventTotals?.credits ?? 0),
        events: Number(eventTotals?.events ?? 0),
      },
      // Charged is what workspaces burned in credits, valued at the credit rate;
      // cost is what the providers billed us for the same runs.
      margin: {
        chargedUsd: windowChargedUsd,
        costUsd: windowCostUsd,
        marginUsd: windowChargedUsd - windowCostUsd,
        events: Number(windowEvents?.events ?? 0),
      },
      bugs: {
        open: Number(
          bugCounts.find((row) => row.status === BugReportStatus.OPEN)?.count ?? 0,
        ),
        inProgress: Number(
          bugCounts.find((row) => row.status === BugReportStatus.IN_PROGRESS)?.count ?? 0,
        ),
        total: bugCounts.reduce((sum, row) => sum + Number(row.count), 0),
      },
    };
  }

  /**
   * Daily signups and platform-wide credit burn over the window.
   *
   * Two separate group-bys stitched together on the day key rather than a join:
   * a workspace created on a quiet day has no events, an event can land on a day
   * nobody signed up, and an inner join would silently drop whichever side was
   * missing. Days with neither still appear, at zero, so the chart's x-axis is
   * the calendar rather than the data.
   */
  async growth(days = 30) {
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);

    const [signups, usage] = await Promise.all([
      this.workspaceRepository
        .createQueryBuilder('workspace')
        .select(`to_char(date_trunc('day', workspace."createdAt"), 'YYYY-MM-DD')`, 'day')
        .addSelect('COUNT(workspace.id)', 'count')
        .where('workspace."createdAt" >= :from', { from })
        .groupBy('day')
        .getRawMany<{ day: string; count: string }>(),
      this.creditEventRepository
        .createQueryBuilder('event')
        .select(`to_char(date_trunc('day', event."createdAt"), 'YYYY-MM-DD')`, 'day')
        .addSelect('COALESCE(SUM(event."creditsUsed"), 0)', 'credits')
        .addSelect('COALESCE(SUM(event."providerCostUsd"), 0)', 'cost')
        .where('event."createdAt" >= :from', { from })
        .groupBy('day')
        .getRawMany<{ day: string; credits: string; cost: string }>(),
    ]);

    const signupsByDay = new Map(signups.map((row) => [row.day, Number(row.count)]));
    const usageByDay = new Map(usage.map((row) => [row.day, row]));

    const series: Array<{ day: string; signups: number; credits: number; costUsd: number }> = [];
    const cursor = new Date(from);
    cursor.setUTCHours(0, 0, 0, 0);
    const last = new Date(to);
    last.setUTCHours(0, 0, 0, 0);
    while (cursor.getTime() <= last.getTime()) {
      const day = cursor.toISOString().slice(0, 10);
      const row = usageByDay.get(day);
      series.push({
        day,
        signups: signupsByDay.get(day) ?? 0,
        credits: Number(row?.credits ?? 0),
        costUsd: Number(row?.cost ?? 0),
      });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { days, series };
  }

  /** One inbox row, with its workspace and reporter flattened for the table. */
  private toBugReportView(report: BugReport) {
    return {
      id: report.id,
      title: report.title,
      description: report.description,
      stepsToReproduce: report.stepsToReproduce,
      severity: report.severity,
      status: report.status,
      pageUrl: report.pageUrl,
      userAgent: report.userAgent,
      resolutionNote: report.resolutionNote,
      resolvedAt: report.resolvedAt,
      createdAt: report.createdAt,
      workspace: report.workspace
        ? { id: report.workspace.id, name: report.workspace.name }
        : null,
      // A report outlives its reporter's account, so the name may be gone.
      reportedBy: report.reportedBy
        ? {
            id: report.reportedBy.id,
            name: report.reportedBy.name,
            email: report.reportedBy.email,
            avatarUrl: report.reportedBy.avatarUrl,
          }
        : null,
    };
  }

  /**
   * The bug inbox, across every tenant, with the reporter and workspace
   * resolved so a row is readable without a second request.
   */
  async listBugReports(options: { status?: BugReportStatus; limit?: number } = {}) {
    const reports = await this.bugReportRepository.find({
      where: options.status ? { status: options.status } : {},
      relations: { workspace: true, reportedBy: true },
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(options.limit ?? 100, 1), 500),
    });
    return reports.map((report) => this.toBugReportView(report));
  }

  /**
   * Triage one report.
   *
   * `resolvedAt` is derived from the status rather than accepted from the
   * caller: it is the same fact said twice, and letting them disagree makes
   * "when was this fixed" unanswerable. Moving a report back out of a closed
   * state clears the stamp for the same reason.
   */
  async updateBugReport(
    id: string,
    changes: { status?: BugReportStatus; resolutionNote?: string | null },
  ) {
    const report = await this.bugReportRepository.findOne({
      where: { id },
      relations: { workspace: true, reportedBy: true },
    });
    if (!report) {
      throw new NotFoundException(`Bug report ${id} not found`);
    }

    if (changes.status !== undefined) {
      const closed =
        changes.status === BugReportStatus.RESOLVED ||
        changes.status === BugReportStatus.DISMISSED;
      report.status = changes.status;
      report.resolvedAt = closed ? (report.resolvedAt ?? new Date()) : null;
    }
    if (changes.resolutionNote !== undefined) {
      report.resolutionNote = changes.resolutionNote;
    }

    // save() returns the entity without its relations re-attached, so the view
    // is built from the row we already loaded them onto.
    await this.bugReportRepository.save(report);
    return this.toBugReportView(report);
  }
}
