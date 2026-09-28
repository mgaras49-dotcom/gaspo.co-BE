import { findPlan } from '../billing/plans';
import { SubscriptionStatus } from '../common/enums';

/**
 * Where a workspace sits in the sales funnel. Every workspace is in exactly one.
 *
 * "Trial" here is not a Stripe status. The trial is a grant of reward credits
 * that never expires, so a workspace that signed up in March and never came back
 * is technically still "on trial" — and counting it as one would answer "how
 * many trials are running" with every signup that never paid. The three trial
 * stages split that pile by what is actually happening: still using it, gone
 * quiet, or out of credits (the one a salesperson should call first).
 *
 * The rule itself lives in SQL, in `SuperAdminService`, so that the overview
 * counts and the customer-table filter cannot disagree about who is where.
 */
export type WorkspaceStage =
  /** On a plan that is billing: `active`, or `past_due` while Stripe retries. */
  | 'subscribed'
  /** Has paid for credits, but has no live plan and never cancelled one. */
  | 'topup_only'
  /** Had a plan and cancelled it. */
  | 'canceled'
  /** Never paid, credits left, ran something inside the active window. */
  | 'trial_active'
  /** Never paid, credits left, nothing inside the active window. */
  | 'trial_idle'
  /** Never paid, no credits left. */
  | 'trial_spent';

export const WORKSPACE_STAGES: readonly WorkspaceStage[] = [
  'subscribed',
  'topup_only',
  'canceled',
  'trial_active',
  'trial_idle',
  'trial_spent',
];

/**
 * How recently a trial workspace must have run something to count as a trial
 * "being run". Matches the 30-day window the rest of the panel uses for
 * "active", so the Workspaces card and the trial count read on the same clock.
 */
export const ACTIVE_TRIAL_DAYS = 30;

/** Plan statuses that make a workspace a subscriber — and count toward MRR. */
export const SUBSCRIBED_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
];

/** One group from the stage query: a stage, a plan, and how many sit there. */
export interface StageCountRow {
  stage: WorkspaceStage;
  planId: string | null;
  count: number;
  pastDue: number;
  cancelling: number;
}

export interface SalesSummary {
  /** Workspace counts per stage; every stage present, at zero if empty. */
  stages: Record<WorkspaceStage, number>;
  /** Everyone whose money is in and who has not cancelled: plan or top-ups. */
  payingCustomers: number;
  /** Subscribers still billing but whose last charge failed. */
  pastDue: number;
  /** Subscribers who have cancelled but whose paid period has not run out. */
  cancelling: number;
  /**
   * Monthly recurring revenue, in cents: the list price of every plan in the
   * `subscribed` stage. Past-due plans are included — Stripe is still trying
   * to collect them — and cancelling ones too, until their period ends.
   */
  mrrCents: number;
  /** Subscribers by plan, most MRR first. */
  plans: Array<{ planId: string; label: string; customers: number; mrrCents: number }>;
  /** Share of all workspaces that have ever paid (subscribed, top-ups, or cancelled). */
  conversionRate: number;
  activeTrialDays: number;
}

/**
 * Fold the grouped stage rows into the numbers the panel shows.
 *
 * MRR is priced here from the plan ladder rather than read from Stripe: every
 * checkout is a single line at the plan's list price with quantity 1, so the
 * ladder *is* the price. A plan id that is no longer on the ladder still counts
 * as a subscriber, at zero, rather than vanishing from the count.
 */
export function summarizeSales(rows: StageCountRow[]): SalesSummary {
  const stages = Object.fromEntries(WORKSPACE_STAGES.map((stage) => [stage, 0])) as Record<
    WorkspaceStage,
    number
  >;
  const plans = new Map<
    string,
    { planId: string; label: string; customers: number; mrrCents: number }
  >();
  let pastDue = 0;
  let cancelling = 0;

  for (const row of rows) {
    stages[row.stage] += row.count;
    if (row.stage !== 'subscribed') continue;

    pastDue += row.pastDue;
    cancelling += row.cancelling;
    const planId = row.planId ?? 'unknown';
    const plan = findPlan(planId);
    const entry = plans.get(planId) ?? {
      planId,
      label: plan?.label ?? planId,
      customers: 0,
      mrrCents: 0,
    };
    entry.customers += row.count;
    entry.mrrCents += row.count * (plan?.priceCents ?? 0);
    plans.set(planId, entry);
  }

  const total = WORKSPACE_STAGES.reduce((sum, stage) => sum + stages[stage], 0);
  const everPaid = stages.subscribed + stages.topup_only + stages.canceled;
  const planList = [...plans.values()].sort(
    (a, b) => b.mrrCents - a.mrrCents || b.customers - a.customers,
  );

  return {
    stages,
    payingCustomers: stages.subscribed + stages.topup_only,
    pastDue,
    cancelling,
    mrrCents: planList.reduce((sum, plan) => sum + plan.mrrCents, 0),
    plans: planList,
    conversionRate: total > 0 ? everPaid / total : 0,
    activeTrialDays: ACTIVE_TRIAL_DAYS,
  };
}
