import assert from 'node:assert/strict';
import test from 'node:test';
import { hasRequiredMetaScope, MetaPermissionsError, parseDebugToken } from './meta-mcp.service';

// The shape Meta returned for the permission-less system-user tokens of Nov 2026.
const PUBLIC_PROFILE_ONLY = {
  data: {
    app_id: '824452353937204',
    type: 'SYSTEM_USER',
    application: 'Gaspo',
    data_access_expires_at: 0,
    expires_at: 0,
    is_valid: true,
    scopes: ['public_profile'],
    user_id: '122096205831435686',
  },
};

void test('a debug_token response reduces to its scopes, never-expiring stays null', () => {
  assert.deepEqual(parseDebugToken(PUBLIC_PROFILE_ONLY), {
    scopes: ['public_profile'],
    expiresAt: null,
  });
});

void test('a user token with an expiry gets a Date from the unix seconds', () => {
  const info = parseDebugToken({
    data: {
      type: 'USER',
      expires_at: 1799798400,
      is_valid: true,
      scopes: ['ads_management', 'ads_read', 'business_management', 'public_profile'],
      granular_scopes: [{ scope: 'ads_read', target_ids: ['1471210033594550'] }],
    },
  });
  assert.deepEqual(info?.scopes, [
    'ads_management',
    'ads_read',
    'business_management',
    'public_profile',
  ]);
  assert.equal(info?.expiresAt?.toISOString(), '2027-01-13T00:00:00.000Z');
});

void test('an error body or a response without scopes is not a token inspection', () => {
  assert.equal(parseDebugToken({ error: { message: 'Invalid OAuth access token.' } }), null);
  assert.equal(parseDebugToken({ data: { is_valid: false } }), null);
  assert.equal(parseDebugToken(null), null);
});

void test('ads_read is required, unknown scopes are not a refusal', () => {
  assert.equal(
    hasRequiredMetaScope('ads_management ads_read business_management public_profile'),
    true,
  );
  assert.equal(hasRequiredMetaScope('ads_read'), true);
  assert.equal(hasRequiredMetaScope('public_profile'), false);
  assert.equal(hasRequiredMetaScope(''), false);
  assert.equal(hasRequiredMetaScope(null), true);
});

void test('the refusal names what Meta did grant', () => {
  const error = new MetaPermissionsError('public_profile');
  assert.equal(error.message, 'Meta granted only [public_profile]; ads_read is required');
  assert.equal(error.granted, 'public_profile');
  assert.ok(error instanceof Error);
});
