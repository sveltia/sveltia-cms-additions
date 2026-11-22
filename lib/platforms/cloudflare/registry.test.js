import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, test } from 'vitest';

import { getLockObject, resetState } from '../../test/helpers.js';

import { addTenant, listTenants, removeTenant } from './registry.js';

/**
 * @import { SqlStorage } from '../../types.js';
 */

/**
 * Run a test with the SQL storage of a Durable Object, with an empty registry.
 * @param {(sql: SqlStorage) => void} callback Test.
 * @returns {Promise<void>}
 */
const withStorage = (callback) =>
  runInDurableObject(getLockObject(), (_instance, state) => {
    state.storage.sql.exec('DROP TABLE IF EXISTS tenant');
    callback(state.storage.sql);
  });

const ACME = { id: 'acme', name: 'Acme Inc.', created_at: '2026-10-13T00:00:00.000Z' };
const BETA = { id: 'beta', name: 'Beta', created_at: '2026-10-14T00:00:00.000Z' };

beforeEach(async () => {
  await resetState();
});

describe('registry', () => {
  test('lists the tenants by ID, adding and removing each once', () =>
    withStorage((sql) => {
      expect(listTenants(sql)).toEqual([]);
      expect(addTenant(sql, BETA)).toBe(true);
      expect(addTenant(sql, ACME)).toBe(true);
      expect(addTenant(sql, { ...ACME, name: 'Other' })).toBe(false);
      expect(listTenants(sql)).toEqual([ACME, BETA]);

      expect(removeTenant(sql, 'acme')).toBe(true);
      expect(removeTenant(sql, 'acme')).toBe(false);
      expect(listTenants(sql)).toEqual([BETA]);
    }));
});
