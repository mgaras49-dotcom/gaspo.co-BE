import assert from 'node:assert/strict';
import test from 'node:test';
import { describeNow } from './clock';

const instant = new Date('2026-10-05T08:42:00Z');

test("describeNow reads the time in the requester's own zone", () => {
  assert.equal(
    describeNow(instant, 'Australia/Sydney'),
    'Monday, 5 October 2026 at 19:42 (Australia/Sydney)',
  );
});

test('describeNow falls back to UTC when the zone is missing or unknown', () => {
  assert.equal(describeNow(instant, null), 'Monday, 5 October 2026 at 08:42 (UTC)');
  assert.equal(describeNow(instant, 'Mars/Olympus'), 'Monday, 5 October 2026 at 08:42 (UTC)');
});
