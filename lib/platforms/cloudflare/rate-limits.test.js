import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, test } from 'vitest';

import { getLockObject, resetState } from '../../test/helpers.js';

import { consumeRateLimit, createRateLimitTable, refundRateLimit } from './rate-limits.js';

/**
 * @import { SqlStorage } from '../../types.js';
 */

/**
 * Run a test with the SQL storage of a Durable Object.
 * @param {(sql: SqlStorage) => void} callback Test.
 * @returns {Promise<void>}
 */
const withStorage = (callback) =>
  runInDurableObject(getLockObject(), (_instance, state) => {
    createRateLimitTable(state.storage.sql);
    state.storage.sql.exec('DELETE FROM rate_limit');
    callback(state.storage.sql);
  });

const NOW = Date.parse('2026-10-13T00:00:00Z');

beforeEach(async () => {
  await resetState();
});

describe('rate limits', () => {
  test('allow requests up to the limit in a window, then say when to try again', () =>
    withStorage((sql) => {
      const args = { key: 'k', limit: 2, windowSeconds: 60, now: NOW };

      expect(consumeRateLimit(sql, args)).toEqual({ allowed: true, retryAfter: 0 });
      expect(consumeRateLimit(sql, args)).toEqual({ allowed: true, retryAfter: 0 });
      expect(consumeRateLimit(sql, { ...args, now: NOW + 15_000 })).toEqual({
        allowed: false,
        retryAfter: 45,
      });
      // Another key has its own count
      expect(consumeRateLimit(sql, { ...args, key: 'other' })).toMatchObject({ allowed: true });
      // A new window starts once the previous one is over
      expect(consumeRateLimit(sql, { ...args, now: NOW + 60_000 })).toMatchObject({
        allowed: true,
      });
    }));

  test('take back a request, but never below zero', () =>
    withStorage((sql) => {
      const args = { key: 'k', limit: 1, windowSeconds: 60, now: NOW };

      consumeRateLimit(sql, args);
      refundRateLimit(sql, 'k');
      refundRateLimit(sql, 'k');
      expect(consumeRateLimit(sql, args)).toMatchObject({ allowed: true });
      expect(consumeRateLimit(sql, args)).toMatchObject({ allowed: false });
    }));
});
