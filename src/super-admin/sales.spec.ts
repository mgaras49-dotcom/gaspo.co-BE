import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORKSPACE_STAGES, summarizeSales } from './sales';

test('every stage is reported, at zero when nobody is in it', () => {
  const summary = summarizeSales([]);
  assert.deepEqual(Object.keys(summary.stages).sort(), [...WORKSPACE_STAGES].sort());
  assert.ok(Object.values(summary.stages).every((count) => count === 0));
  assert.equal(summary.payingCustomers, 0);
  assert.equal(summary.mrrCents, 0);
  assert.equal(summary.conversionRate, 0);
});

test('MRR prices each subscriber at its plan and ranks plans by it', () => {
  const summary = summarizeSales([
    { stage: 'subscribed', planId: 'starter', count: 3, pastDue: 1, cancelling: 0 },
    { stage: 'subscribed', planId: 'business', count: 1, pastDue: 0, cancelling: 1 },
  ]);
  // 3 × $50 + 1 × $200
  assert.equal(summary.mrrCents, 35_000);
  assert.deepEqual(
    summary.plans.map((plan) => [plan.planId, plan.customers, plan.mrrCents]),
    [
      ['business', 1, 20_000],
      ['starter', 3, 15_000],
    ],
  );
  assert.equal(summary.pastDue, 1);
  assert.equal(summary.cancelling, 1);
});

test('paying customers are subscribers plus top-up buyers, never cancelled plans', () => {
  const summary = summarizeSales([
    { stage: 'subscribed', planId: 'team', count: 2, pastDue: 0, cancelling: 0 },
    { stage: 'topup_only', planId: null, count: 3, pastDue: 0, cancelling: 0 },
    { stage: 'canceled', planId: 'team', count: 4, pastDue: 0, cancelling: 0 },
    { stage: 'trial_active', planId: null, count: 1, pastDue: 0, cancelling: 0 },
  ]);
  assert.equal(summary.payingCustomers, 5);
  // A cancelled plan is not recurring revenue, and its plan id must not leak
  // into the per-plan table.
  assert.equal(summary.mrrCents, 2 * 10_000);
  assert.deepEqual(
    summary.plans.map((plan) => plan.planId),
    ['team'],
  );
  assert.equal(summary.plans[0].customers, 2);
});

test('conversion counts everyone who ever paid, over every workspace', () => {
  const summary = summarizeSales([
    { stage: 'subscribed', planId: 'starter', count: 1, pastDue: 0, cancelling: 0 },
    { stage: 'topup_only', planId: null, count: 1, pastDue: 0, cancelling: 0 },
    { stage: 'canceled', planId: 'starter', count: 1, pastDue: 0, cancelling: 0 },
    { stage: 'trial_active', planId: null, count: 2, pastDue: 0, cancelling: 0 },
    { stage: 'trial_idle', planId: null, count: 2, pastDue: 0, cancelling: 0 },
    { stage: 'trial_spent', planId: null, count: 1, pastDue: 0, cancelling: 0 },
  ]);
  assert.equal(summary.conversionRate, 3 / 8);
});

test('a plan no longer on the ladder still counts as a subscriber, at no MRR', () => {
  const summary = summarizeSales([
    { stage: 'subscribed', planId: 'legacy-gold', count: 1, pastDue: 0, cancelling: 0 },
  ]);
  assert.equal(summary.stages.subscribed, 1);
  assert.equal(summary.payingCustomers, 1);
  assert.equal(summary.mrrCents, 0);
  assert.deepEqual(summary.plans, [
    { planId: 'legacy-gold', label: 'legacy-gold', customers: 1, mrrCents: 0 },
  ]);
});
