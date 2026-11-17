import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdSetBody, buildCampaignBody, CreateAdSetParams } from './meta-ads.service';

const AD_SET: CreateAdSetParams = {
  adAccountId: 'act_1709976226241899',
  campaignId: '120254856856940195',
  name: 'Gaspo test ad set',
  optimizationGoal: 'LINK_CLICKS',
  billingEvent: 'IMPRESSIONS',
  targeting: { geo_locations: { countries: ['PK'] }, age_min: 18, age_max: 65 },
  dailyBudget: 200000,
};

void test('buildCampaignBody names the bid strategy when the campaign carries the budget', () => {
  // Left to Meta, a budgeted campaign came back LOWEST_COST_WITH_BID_CAP and
  // every ad set under it then failed with "Bid amount required" (17 Nov 2026).
  const body = buildCampaignBody({
    adAccountId: 'act_1',
    name: 'Gaspo test 17 Nov',
    objective: 'OUTCOME_TRAFFIC',
    dailyBudget: 200000,
  });
  assert.equal(body.bid_strategy, 'LOWEST_COST_WITHOUT_CAP');
  assert.equal(body.daily_budget, '200000');
  assert.equal(body.status, 'PAUSED');
  assert.equal(body.is_adset_budget_sharing_enabled, undefined);
});

void test('buildCampaignBody leaves bidding to the ad sets when the campaign has no budget', () => {
  const body = buildCampaignBody({ adAccountId: 'act_1', name: 'x', objective: 'OUTCOME_TRAFFIC' });
  assert.equal(body.bid_strategy, undefined);
  assert.equal(body.is_adset_budget_sharing_enabled, 'false');
});

void test('buildAdSetBody drops the ad set budget and strategy under a campaign budget', () => {
  // Meta: "You can only set an ad set budget or a campaign budget" (1885621),
  // and ad sets share the campaign's bid strategy.
  const body = buildAdSetBody(AD_SET, {
    daily_budget: '250000',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
  });
  assert.equal(body.daily_budget, undefined);
  assert.equal(body.bid_strategy, undefined);
  assert.equal(body.bid_amount, undefined);
  assert.equal(body.status, 'PAUSED');
  assert.deepEqual(JSON.parse(body.targeting), {
    geo_locations: { countries: ['PK'] },
    age_min: 18,
    age_max: 65,
    targeting_automation: { advantage_audience: 0 },
  });
});

void test('buildAdSetBody explains a capped campaign strategy instead of letting Meta fail', () => {
  assert.throws(
    () =>
      buildAdSetBody(AD_SET, { daily_budget: '250000', bid_strategy: 'LOWEST_COST_WITH_BID_CAP' }),
    /bid_amount.*LOWEST_COST_WITHOUT_CAP.*meta_ads_update_campaign/,
  );
});

void test('buildAdSetBody passes the bid cap through under a capped campaign strategy', () => {
  const body = buildAdSetBody(
    { ...AD_SET, bidAmount: 150 },
    { daily_budget: '250000', bid_strategy: 'COST_CAP' },
  );
  assert.equal(body.bid_amount, '150');
  assert.equal(body.bid_strategy, undefined);
});

void test('buildAdSetBody gives the ad set its own budget and lowest-cost bidding otherwise', () => {
  const body = buildAdSetBody(AD_SET, {});
  assert.equal(body.daily_budget, '200000');
  assert.equal(body.bid_strategy, 'LOWEST_COST_WITHOUT_CAP');
  assert.equal(body.bid_amount, undefined);
});

void test('buildAdSetBody treats a zero campaign budget as none', () => {
  const body = buildAdSetBody(AD_SET, { daily_budget: '0' });
  assert.equal(body.daily_budget, '200000');
});

void test('buildAdSetBody refuses an ad set with no budget anywhere', () => {
  assert.throws(
    () => buildAdSetBody({ ...AD_SET, dailyBudget: undefined }, {}),
    /needs a daily_budget/,
  );
});

void test('buildAdSetBody keeps a caller-supplied targeting_automation and schedule', () => {
  const body = buildAdSetBody(
    {
      ...AD_SET,
      targeting: { ...AD_SET.targeting, targeting_automation: { advantage_audience: 1 } },
      startTime: '2026-11-18T00:00:00+0500',
    },
    {},
  );
  assert.deepEqual(JSON.parse(body.targeting).targeting_automation, { advantage_audience: 1 });
  assert.equal(body.start_time, '2026-11-18T00:00:00+0500');
});
