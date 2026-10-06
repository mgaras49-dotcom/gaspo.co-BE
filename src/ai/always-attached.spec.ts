import assert from 'node:assert/strict';
import test from 'node:test';
import { withAlwaysAttached } from './ai.service';

const googleAds = [
  { name: 'google_ads-list-campaigns' },
  { name: 'google_ads-create-or-update-campaign-budget' },
  { name: 'google_ads-list-account-id-options' },
];

void test('Google Ads always carries its list of reachable accounts', () => {
  assert.deepEqual(
    withAlwaysAttached('google_ads', ['google_ads-create-or-update-campaign-budget'], googleAds),
    ['google_ads-create-or-update-campaign-budget', 'google_ads-list-account-id-options'],
  );
});

void test('an always-attached action is not invented when the app lacks it', () => {
  assert.deepEqual(
    withAlwaysAttached(
      'google_ads',
      ['google_ads-list-campaigns'],
      [{ name: 'google_ads-list-campaigns' }],
    ),
    ['google_ads-list-campaigns'],
  );
  assert.deepEqual(
    withAlwaysAttached('gmail', ['gmail-find-email'], [{ name: 'gmail-find-email' }]),
    ['gmail-find-email'],
  );
});
