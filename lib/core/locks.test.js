import { beforeEach, describe, expect, test } from 'vitest';

import { db, resetState } from '../test/helpers.js';

import {
  acquireLock,
  createTicket,
  expireLocks,
  GRACE_PERIOD,
  handleLockMessage,
  listLocks,
  MAX_KEY_LENGTH,
  MAX_LOCKS_PER_USER,
  MAX_MESSAGE_SIZE,
  orphanLocks,
  redeemTicket,
  releaseLock,
  takeOverLock,
  TICKET_TTL,
} from './locks.js';

/**
 * @import { LockClient } from './locks.js';
 * @import { Database } from '../types.js';
 */

const NOW = Date.UTC(2026, 9, 13);

/** @type {LockClient} */
const ADA = { connection: 'c1', userId: 'u1', name: 'Ada', role: 'editor' };
/** @type {LockClient} */
const ADA_TAB_2 = { ...ADA, connection: 'c2' };
/** @type {LockClient} */
const BOB = { connection: 'c3', userId: 'u2', name: 'Bob', role: 'admin' };
/** @type {LockClient} */
const VIC = { connection: 'c4', userId: 'u3', name: 'Vic', role: 'viewer' };

/**
 * Run a test with the default tenant’s database, which holds the locks.
 * @param {(sql: Database) => Promise<void>} callback Test.
 * @returns {Promise<void>}
 */
const withStorage = (callback) => callback(db);

beforeEach(async () => {
  await resetState();
});

describe('acquireLock', () => {
  test('grants a free lock, and refuses it to anyone else, the same user in another tab included', () =>
    withStorage(async (sql) => {
      expect(await acquireLock(sql, ADA, 'posts/hello@main', NOW)).toEqual({
        ok: true,
        changed: true,
        lock: {
          key: 'posts/hello@main',
          user_id: 'u1',
          name: 'Ada',
          since: '2026-10-13T00:00:00.000Z',
          connection: 'c1',
        },
      });
      // Again from the same connection: nothing changes
      expect(await acquireLock(sql, ADA, 'posts/hello@main', NOW + 1)).toMatchObject({
        ok: true,
        changed: false,
        lock: { since: '2026-10-13T00:00:00.000Z' },
      });
      expect(await acquireLock(sql, BOB, 'posts/hello@main', NOW)).toMatchObject({
        ok: false,
        reason: 'held',
        lock: { name: 'Ada' },
      });
      expect(await acquireLock(sql, ADA_TAB_2, 'posts/hello@main', NOW)).toMatchObject({
        ok: false,
        reason: 'held',
      });
    }));

  test('passes the user’s lock from a closed connection to their new one', () =>
    withStorage(async (sql) => {
      await acquireLock(sql, ADA, 'posts/hello@main', NOW);
      expect(await orphanLocks(sql, 'c1', NOW)).toBe(1);
      // Someone else still has to wait for the grace period
      expect(await acquireLock(sql, BOB, 'posts/hello@main', NOW)).toMatchObject({ ok: false });
      expect(await acquireLock(sql, ADA_TAB_2, 'posts/hello@main', NOW + 5)).toMatchObject({
        ok: true,
        changed: true,
        lock: { connection: 'c2' },
      });
      // No longer orphaned
      expect((await expireLocks(sql, NOW + GRACE_PERIOD + 10)).released).toEqual([]);
    }));

  test('refuses viewers, invalid keys and too many locks', () =>
    withStorage(async (sql) => {
      expect(await acquireLock(sql, VIC, 'posts/a@main')).toEqual({
        ok: false,
        reason: 'forbidden',
      });
      expect(await acquireLock(sql, ADA, '')).toEqual({ ok: false, reason: 'invalid_key' });
      expect(await acquireLock(sql, ADA, /** @type {any} */ (1))).toEqual({
        ok: false,
        reason: 'invalid_key',
      });
      expect(await acquireLock(sql, ADA, 'x'.repeat(MAX_KEY_LENGTH + 1))).toEqual({
        ok: false,
        reason: 'invalid_key',
      });

      await Promise.all(
        Array.from({ length: MAX_LOCKS_PER_USER }, (_, index) =>
          acquireLock(sql, ADA, `posts/${index}@main`),
        ),
      );

      expect(await acquireLock(sql, ADA, 'posts/more@main')).toEqual({
        ok: false,
        reason: 'too_many_locks',
      });
      // One already held is fine
      expect(await acquireLock(sql, ADA, 'posts/0@main')).toMatchObject({ ok: true });
    }));
});

describe('takeOverLock', () => {
  test('takes a lock from whoever holds it', () =>
    withStorage(async (sql) => {
      expect(await takeOverLock(sql, BOB, 'posts/a@main', NOW)).toMatchObject({
        ok: true,
        changed: true,
      });
      expect(await takeOverLock(sql, BOB, 'posts/a@main', NOW)).toMatchObject({
        ok: true,
        changed: false,
      });
      expect(await takeOverLock(sql, ADA, 'posts/a@main', NOW + 1)).toMatchObject({
        ok: true,
        changed: true,
        lock: { name: 'Ada' },
        previous: { name: 'Bob' },
      });
      expect(await takeOverLock(sql, VIC, 'posts/a@main')).toEqual({
        ok: false,
        reason: 'forbidden',
      });
    }));
});

describe('connection IDs', () => {
  test('don’t let another user act on a lock with the holder’s connection ID', () =>
    withStorage(async (sql) => {
      /** @type {LockClient} */
      const impostor = { ...BOB, connection: ADA.connection };

      await acquireLock(sql, ADA, 'k', NOW);

      expect(await releaseLock(sql, impostor, 'k')).toBe(false);
      expect(await acquireLock(sql, impostor, 'k', NOW)).toMatchObject({
        ok: false,
        reason: 'held',
      });
      expect(await listLocks(sql)).toMatchObject([{ key: 'k', user_id: 'u1' }]);
    }));
});

describe('releaseLock and expireLocks', () => {
  test('release only the holder’s lock, and closed connections’ locks after the grace period', () =>
    withStorage(async (sql) => {
      await acquireLock(sql, ADA, 'posts/a@main', NOW);
      await acquireLock(sql, BOB, 'posts/b@main', NOW);
      expect(await releaseLock(sql, BOB, 'posts/a@main')).toBe(false);
      expect(await releaseLock(sql, ADA, 'posts/a@main')).toBe(true);
      expect(await releaseLock(sql, ADA, 'posts/a@main')).toBe(false);

      expect(await expireLocks(sql, NOW)).toEqual({ released: [], next: null });
      await orphanLocks(sql, 'c3', NOW);
      expect(await expireLocks(sql, NOW + GRACE_PERIOD - 1)).toEqual({
        released: [],
        next: NOW + GRACE_PERIOD,
      });
      expect(await expireLocks(sql, NOW + GRACE_PERIOD)).toEqual({
        released: ['posts/b@main'],
        next: null,
      });
      expect(await listLocks(sql)).toEqual([]);
    }));
});

describe('tickets', () => {
  /**
   * Add a user, whom tickets are checked against when redeemed.
   * @param {Record<string, any>} [changes] Columns to set.
   * @returns {Promise<void>}
   */
  const saveUser = async (changes = {}) => {
    const now = new Date().toISOString();

    await db
      .insertInto('user')
      .values({
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        emailVerified: 0,
        createdAt: now,
        updatedAt: now,
        role: 'editor',
        ...changes,
      })
      .onConflict((oc) =>
        Object.keys(changes).length
          ? oc.column('id').doUpdateSet(changes)
          : oc.column('id').doNothing(),
      )
      .execute();
  };

  test('are single-use and expire', () =>
    withStorage(async (sql) => {
      await saveUser();

      const ticket = await createTicket(sql, { userId: 'u1', name: 'Ada', role: 'editor' }, NOW);

      expect(ticket).toMatch(/^[\w-]{32}$/);
      expect(await redeemTicket(sql, ticket, NOW + 1)).toEqual({
        userId: 'u1',
        name: 'Ada',
        role: 'editor',
      });
      expect(await redeemTicket(sql, ticket, NOW + 1)).toBeUndefined();
      expect(await redeemTicket(sql, null)).toBeUndefined();

      const expired = await createTicket(sql, { userId: 'u1', name: 'Ada', role: 'editor' }, NOW);

      expect(await redeemTicket(sql, expired, NOW + TICKET_TTL)).toBeUndefined();
    }));

  test('open a connection with the user’s current role, and none once they’re disabled', () =>
    withStorage(async (sql) => {
      await saveUser();

      const demoted = await createTicket(sql, { userId: 'u1', name: 'Ada', role: 'editor' }, NOW);

      await saveUser({ role: 'viewer' });
      expect(await redeemTicket(sql, demoted, NOW + 1)).toMatchObject({ role: 'viewer' });

      const disabled = await createTicket(sql, { userId: 'u1', name: 'Ada', role: 'viewer' }, NOW);

      await saveUser({ banned: 1 });
      expect(await redeemTicket(sql, disabled, NOW + 1)).toBeUndefined();

      const deleted = await createTicket(sql, { userId: 'u1', name: 'Ada', role: 'viewer' }, NOW);

      await db.deleteFrom('user').where('id', '=', 'u1').execute();
      expect(await redeemTicket(sql, deleted, NOW + 1)).toBeUndefined();
    }));
});

describe('handleLockMessage', () => {
  test('answers acquire, takeover and release, broadcasting changes', () =>
    withStorage(async (sql) => {
      expect(
        await handleLockMessage(sql, ADA, JSON.stringify({ type: 'acquire', key: 'k' }), NOW),
      ).toEqual({
        reply: [],
        broadcast: [{ type: 'changed', key: 'k', lock: expect.objectContaining({ name: 'Ada' }) }],
      });
      // Already held: only the sender hears about it
      expect(
        await handleLockMessage(sql, ADA, JSON.stringify({ type: 'acquire', key: 'k' })),
      ).toEqual({
        reply: [{ type: 'changed', key: 'k', lock: expect.objectContaining({ name: 'Ada' }) }],
        broadcast: [],
      });
      expect(
        await handleLockMessage(sql, BOB, JSON.stringify({ type: 'acquire', key: 'k' })),
      ).toEqual({
        reply: [
          {
            type: 'refused',
            key: 'k',
            reason: 'held',
            lock: expect.objectContaining({ name: 'Ada' }),
          },
        ],
        broadcast: [],
      });
      expect(
        await handleLockMessage(sql, VIC, JSON.stringify({ type: 'takeover', key: 'k' })),
      ).toEqual({
        reply: [{ type: 'refused', key: 'k', reason: 'forbidden' }],
        broadcast: [],
      });
      expect(
        (await handleLockMessage(sql, BOB, JSON.stringify({ type: 'takeover', key: 'k' })))
          .broadcast,
      ).toEqual([{ type: 'changed', key: 'k', lock: expect.objectContaining({ name: 'Bob' }) }]);
      // Ada no longer holds it
      expect(
        await handleLockMessage(sql, ADA, JSON.stringify({ type: 'release', key: 'k' })),
      ).toEqual({
        reply: [],
        broadcast: [],
      });
      expect(
        await handleLockMessage(sql, BOB, JSON.stringify({ type: 'release', key: 'k' })),
      ).toEqual({
        reply: [],
        broadcast: [{ type: 'changed', key: 'k', lock: null }],
      });
    }));

  test('refuses anything else', () =>
    withStorage(async (sql) => {
      const invalid = { reply: [{ type: 'error', code: 'invalid_message' }], broadcast: [] };

      expect(await handleLockMessage(sql, ADA, 'not json')).toEqual(invalid);
      expect(await handleLockMessage(sql, ADA, JSON.stringify({ type: 'nope' }))).toEqual(invalid);
      expect(await handleLockMessage(sql, ADA, 'null')).toEqual(invalid);
      expect(await handleLockMessage(sql, ADA, new ArrayBuffer(8))).toEqual(invalid);
      expect(
        await handleLockMessage(
          sql,
          ADA,
          JSON.stringify({ type: 'acquire', key: 'k', pad: 'x'.repeat(MAX_MESSAGE_SIZE) }),
        ),
      ).toEqual(invalid);
    }));
});
