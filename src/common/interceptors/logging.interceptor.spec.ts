import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactUrl } from './logging.interceptor';

test('leaves a plain path untouched', () => {
  assert.equal(redactUrl('/admin/overview'), '/admin/overview');
});

test('leaves non-sensitive query strings untouched', () => {
  assert.equal(redactUrl('/admin/analytics?days=30'), '/admin/analytics?days=30');
});

test('masks a Space magic-link token', () => {
  assert.equal(
    redactUrl('/spaces/my-app/auth/verify?token=abc.SECRETVALUE'),
    '/spaces/my-app/auth/verify?token=[redacted]',
  );
  assert.ok(!redactUrl('/spaces/my-app/auth/verify?token=abc.SECRETVALUE').includes('SECRETVALUE'));
});

test('masks an OAuth callback code and state', () => {
  const redacted = redactUrl('/integrations/meta/callback?code=AQD123&state=opaque-state');
  assert.ok(!redacted.includes('AQD123'));
  assert.ok(!redacted.includes('opaque-state'));
});

test('preserves surrounding parameters while masking the credential', () => {
  assert.equal(
    redactUrl('/integrations/meta/callback?code=AQD123&days=7'),
    '/integrations/meta/callback?code=[redacted]&days=7',
  );
});
