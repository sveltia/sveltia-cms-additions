import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { migrations } from '../../../migrations/index.js';
import { getTestDatabase } from '../../test/helpers.js';
import { migrate } from '../db/migrate.js';

import {
  clearDataKeyCache,
  decryptValue,
  encryptValue,
  getDataKeys,
  rekeyDataKey,
  rewrapDataKey,
} from './data-key.js';

const db = getTestDatabase('data-key');
const SECRET = 'first-secret-0123456789abcdefghijklmnop';
const NEW_SECRET = 'second-secret-0123456789abcdefghijklmno';

/**
 * Get the keys, failing the test if the data key is locked.
 * @param {string} secret Admin secret.
 * @returns {Promise<import('../../types.js').DataKeys>} Keys.
 */
const getKeys = async (secret) => {
  const state = await getDataKeys(db, secret);

  if (state.status !== 'ok') {
    throw new Error('The data key is locked.');
  }

  return state.keys;
};

beforeAll(async () => {
  await migrate(db, migrations);
});

beforeEach(async () => {
  await db.run('DELETE FROM data_key');
  clearDataKeyCache();
});

describe('getDataKeys()', () => {
  test('creates a data key on first use and returns the same keys afterwards', async () => {
    const keys = await getKeys(SECRET);

    clearDataKeyCache();

    const again = await getKeys(SECRET);

    expect(keys.version).toBe(1);
    expect(again.signingSecret).toBe(keys.signingSecret);
    expect(keys.signingSecret).toMatch(/^[\w-]{43}$/);
  });

  test('reports the key as locked with another secret', async () => {
    await getKeys(SECRET);
    clearDataKeyCache();

    await expect(getDataKeys(db, NEW_SECRET)).resolves.toEqual({ status: 'locked' });
  });
});

describe('encryptValue() and decryptValue()', () => {
  test('round-trip a value bound to its location', async () => {
    const keys = await getKeys(SECRET);
    const encrypted = await encryptValue(keys, 'private key', 'setting:ciphertext:a');

    expect(encrypted).not.toContain('private key');
    await expect(decryptValue(keys, encrypted, 'setting:ciphertext:a')).resolves.toBe(
      'private key',
    );
  });

  test('refuse a value moved to another location or tampered with', async () => {
    const keys = await getKeys(SECRET);
    const encrypted = await encryptValue(keys, 'private key', 'setting:ciphertext:a');

    await expect(decryptValue(keys, encrypted, 'setting:ciphertext:b')).resolves.toBeNull();
    await expect(decryptValue(keys, `${encrypted.slice(0, -2)}AA`, 'x')).resolves.toBeNull();
    await expect(decryptValue(keys, `9${encrypted.slice(1)}`, 'x')).resolves.toBeNull();
  });
});

describe('rewrapDataKey()', () => {
  test('keeps the same keys under a new secret', async () => {
    const keys = await getKeys(SECRET);
    const encrypted = await encryptValue(keys, 'value', 'aad');

    await rewrapDataKey(db, { previousSecret: SECRET, secret: NEW_SECRET });

    const rewrapped = await getKeys(NEW_SECRET);

    expect(rewrapped.signingSecret).toBe(keys.signingSecret);
    await expect(decryptValue(rewrapped, encrypted, 'aad')).resolves.toBe('value');
    await expect(getDataKeys(db, SECRET)).resolves.toEqual({ status: 'locked' });
  });

  test('refuses a wrong previous secret', async () => {
    await getKeys(SECRET);

    await expect(
      rewrapDataKey(db, { previousSecret: 'wrong', secret: NEW_SECRET }),
    ).rejects.toThrow('previous admin secret is wrong');
  });

  test('refuses when there is no data key', async () => {
    await expect(rewrapDataKey(db, { previousSecret: SECRET, secret: NEW_SECRET })).rejects.toThrow(
      'no data key',
    );
  });
});

describe('rekeyDataKey()', () => {
  test('replaces the key, so old values can no longer be read', async () => {
    const keys = await getKeys(SECRET);
    const encrypted = await encryptValue(keys, 'value', 'aad');

    await expect(rekeyDataKey(db, NEW_SECRET)).resolves.toBe(2);

    const rekeyed = await getKeys(NEW_SECRET);

    expect(rekeyed.version).toBe(2);
    expect(rekeyed.signingSecret).not.toBe(keys.signingSecret);
    await expect(decryptValue(rekeyed, encrypted, 'aad')).resolves.toBeNull();
  });
});
