import assert from 'node:assert/strict';
import test from 'node:test';
import { withoutBalanceNudge } from './ai.service';

void test('a replayed answer loses its old low-balance footer', () => {
  // As stored on 3 Oct 2026 and replayed after the 5 Oct top-up.
  const stored =
    'Sent to enquiries@bushwakka.com.au ✅\n\n' +
    '_Heads up: this workspace has about $1.96 of credits left. Top up at ' +
    '<https://gaspo.co/dashboard/billing|https://gaspo.co/dashboard/billing>._';
  assert.equal(withoutBalanceNudge(stored), 'Sent to enquiries@bushwakka.com.au ✅');
});

void test('an answer without a footer is replayed unchanged', () => {
  const text = 'Your credits are on the billing page.\n\n_Note: drafts only._';
  assert.equal(withoutBalanceNudge(text), text);
});
