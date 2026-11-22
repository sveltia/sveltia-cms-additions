import { describe, expect, test } from 'vitest';

import { getAdminSecretStatus, getClientKey } from './admin-secret.js';

describe('getAdminSecretStatus()', () => {
  test('reports a missing secret', () => {
    expect(getAdminSecretStatus(undefined)).toBe('missing');
    expect(getAdminSecretStatus('')).toBe('missing');
  });

  test('reports a short secret', () => {
    expect(getAdminSecretStatus('a'.repeat(31))).toBe('too_short');
  });

  test('accepts a secret of 32 characters or more', () => {
    expect(getAdminSecretStatus('a'.repeat(32))).toBe('ok');
    expect(getAdminSecretStatus('a'.repeat(44))).toBe('ok');
  });
});

describe('getClientKey()', () => {
  test('uses an IPv4 address as is', () => {
    expect(getClientKey('203.0.113.7')).toBe('203.0.113.7');
  });

  test('groups IPv6 addresses by their /64 prefix', () => {
    expect(getClientKey('2001:db8:1:2:3:4:5:6')).toBe('2001:0db8:0001:0002::/64');
    expect(getClientKey('2001:DB8:1:2::abcd')).toBe('2001:0db8:0001:0002::/64');
    expect(getClientKey('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(getClientKey('::1')).toBe('0000:0000:0000:0000::/64');
  });

  test('handles a missing address', () => {
    expect(getClientKey(undefined)).toBe('unknown');
  });
});
