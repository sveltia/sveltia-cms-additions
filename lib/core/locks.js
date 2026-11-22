import { toBase64Url } from './crypto/encoding.js';
import {
  acquireLockRow,
  countUserLockRows,
  deleteExpiredTickets,
  deleteLockRow,
  deleteOrphanedLockRows,
  getFirstOrphanedAt,
  getLockRow,
  insertTicket,
  listLockConnections,
  listLockRows,
  orphanLockRows,
  putLockRow,
  takeTicket,
} from './store/locks.js';
import { findUserRow } from './store/users.js';

/**
 * Entry locks: one active editor per entry, so two people don’t overwrite each other’s work. They
 * are advisory, as optimistic concurrency on GitHub still catches real conflicts.
 *
 * Every change is a single statement, so it’s atomic on any database, whichever requests run at
 * the same time.
 */

/**
 * @import { Database } from '../types.js';
 * @import { LockRow } from './store/locks.js';
 */

/**
 * How long a WebSocket ticket can be used.
 */
export const TICKET_TTL = 30 * 1000;

/**
 * How long the locks of a closed connection are kept, so a page reload doesn’t lose them.
 */
export const GRACE_PERIOD = 30 * 1000;

/**
 * Most locks one user can hold at once.
 */
export const MAX_LOCKS_PER_USER = 50;

/**
 * Longest lock key: a collection name, an entry slug or file name, and a branch.
 */
export const MAX_KEY_LENGTH = 512;

/**
 * Largest message a client may send.
 */
export const MAX_MESSAGE_SIZE = 4096;

/**
 * Who a connection belongs to, taken from the ticket, never from a message.
 * @typedef {object} LockClient
 * @property {string} connection Connection ID.
 * @property {string} userId User ID.
 * @property {string} name User’s name.
 * @property {'admin' | 'editor' | 'viewer'} role Role.
 */

/**
 * A lock as clients see it.
 * @typedef {object} PublicLock
 * @property {string} key Lock key.
 * @property {string} user_id ID of the user who holds it.
 * @property {string} name Name of the user who holds it.
 * @property {string} since When it was acquired, as ISO 8601.
 * @property {string} connection Connection that holds it.
 */

/**
 * Outcome of a request to acquire or take over a lock.
 * @typedef {{ ok: true, lock: PublicLock, changed: boolean, previous?: PublicLock } |
 * { ok: false, reason: 'held' | 'forbidden' | 'too_many_locks' | 'invalid_key',
 * lock?: PublicLock }} LockResult
 */

/**
 * Convert a stored lock to what clients see.
 * @param {LockRow} row Row.
 * @returns {PublicLock} Lock.
 */
const toPublicLock = (row) => ({
  key: row.key,
  user_id: row.user_id,
  name: row.name,
  since: new Date(Number(row.since)).toISOString(),
  connection: row.connection,
});

/**
 * Check a client may hold one more lock.
 * @param {Database} db Database.
 * @param {LockClient} client Client.
 * @param {string} key Lock key.
 * @returns {Promise<LockResult | undefined>} Refusal, if any.
 */
const checkClient = async (db, client, key) => {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) {
    return { ok: false, reason: 'invalid_key' };
  }

  if (client.role === 'viewer') {
    return { ok: false, reason: 'forbidden' };
  }

  return (await countUserLockRows(db, client.userId, key)) >= MAX_LOCKS_PER_USER
    ? { ok: false, reason: 'too_many_locks' }
    : undefined;
};

/**
 * Start acquiring or taking over a lock: refuse a client that can’t hold it, and grant the lock
 * to the connection that holds it already, as nothing changes.
 * @param {Database} db Database.
 * @param {LockClient} client Client.
 * @param {string} key Lock key.
 * @returns {Promise<{ result: LockResult } | { row: LockRow | undefined }>} The result, if it’s
 * already known, or the lock as it is, if any, for the caller to decide.
 */
const prepareLock = async (db, client, key) => {
  const refusal = await checkClient(db, client, key);

  if (refusal) {
    return { result: refusal };
  }

  const row = await getLockRow(db, key);

  if (row?.connection === client.connection && row.user_id === client.userId) {
    return { result: { ok: true, lock: toPublicLock(row), changed: false } };
  }

  return { row };
};

/**
 * Get the lock a client asks for, as stored.
 * @param {LockClient} client Client.
 * @param {string} key Lock key.
 * @param {number} now Current time.
 * @returns {Omit<LockRow, 'orphaned_at'>} Lock.
 */
const toLockRow = (client, key, now) => ({
  key,
  user_id: client.userId,
  name: client.name,
  since: now,
  connection: client.connection,
});

/**
 * List every lock.
 * @param {Database} db Database.
 * @returns {Promise<PublicLock[]>} Locks.
 */
export const listLocks = async (db) => (await listLockRows(db)).map(toPublicLock);

/**
 * Acquire a lock for a client. A free lock is granted, as is one the client already holds. The
 * user’s own lock left by a closed connection, e.g. before a page reload, passes to the new one.
 * Anyone else’s lock, including the user’s own in another open tab, is refused: it can be taken
 * over instead.
 * @param {Database} db Database.
 * @param {LockClient} client Client.
 * @param {string} key Lock key.
 * @param {number} [now] Current time.
 * @returns {Promise<LockResult>} Result.
 */
export const acquireLock = async (db, client, key, now = Date.now()) => {
  const prepared = await prepareLock(db, client, key);

  if ('result' in prepared) {
    return prepared.result;
  }

  // Taken if it’s free or the user’s own orphaned lock, checked in the same statement
  const row = toLockRow(client, key, now);
  // Tried again if the holder released it in the meantime, which a shared database allows
  const acquired =
    (await acquireLockRow(db, row)) ??
    ((await getLockRow(db, key)) ? undefined : await acquireLockRow(db, row));

  if (acquired) {
    return { ok: true, lock: toPublicLock(acquired), changed: true };
  }

  const held = await getLockRow(db, key);

  return { ok: false, reason: 'held', ...(held ? { lock: toPublicLock(held) } : {}) };
};

/**
 * Take over a lock, whoever holds it. The previous holder’s editor becomes read-only.
 * @param {Database} db Database.
 * @param {LockClient} client Client.
 * @param {string} key Lock key.
 * @param {number} [now] Current time.
 * @returns {Promise<LockResult>} Result.
 */
export const takeOverLock = async (db, client, key, now = Date.now()) => {
  const prepared = await prepareLock(db, client, key);

  if ('result' in prepared) {
    return prepared.result;
  }

  const { row } = prepared;

  return {
    ok: true,
    lock: toPublicLock(await putLockRow(db, toLockRow(client, key, now))),
    changed: true,
    ...(row ? { previous: toPublicLock(row) } : {}),
  };
};

/**
 * Release a lock the client holds.
 * @param {Database} db Database.
 * @param {LockClient} client Client.
 * @param {string} key Lock key.
 * @returns {Promise<boolean>} Whether a lock was released.
 */
export const releaseLock = (db, client, key) =>
  typeof key === 'string'
    ? deleteLockRow(db, key, client.connection, client.userId)
    : Promise.resolve(false);

/**
 * Mark the locks of a closed connection, which are released after {@link GRACE_PERIOD} unless the
 * user acquires them again from a new connection.
 * @param {Database} db Database.
 * @param {string} connection Connection ID.
 * @param {number} [now] Current time.
 * @returns {Promise<number>} Number of locks marked.
 */
export const orphanLocks = (db, connection, now = Date.now()) =>
  orphanLockRows(db, connection, now);

/**
 * Start the grace period of the locks whose connection is gone without being closed, e.g. as the
 * Durable Object was restarted, which drops its connections without a close event.
 * @param {Database} db Database.
 * @param {string[]} liveConnections Connections that are open.
 * @param {number} [now] Current time.
 * @returns {Promise<number>} Number of locks orphaned.
 */
export const orphanDeadLocks = async (db, liveConnections, now = Date.now()) => {
  const live = new Set(liveConnections);
  const dead = (await listLockConnections(db)).filter((connection) => !live.has(connection));
  const counts = await Promise.all(dead.map((connection) => orphanLocks(db, connection, now)));

  return counts.reduce((sum, count) => sum + count, 0);
};

/**
 * Release the locks whose grace period is over, and drop the expired tickets.
 * @param {Database} db Database.
 * @param {number} [now] Current time.
 * @returns {Promise<{ released: string[], next: number | null }>} Released lock keys, and when the
 * next grace period ends, if any.
 */
export const expireLocks = async (db, now = Date.now()) => {
  const released = await deleteOrphanedLockRows(db, now - GRACE_PERIOD);

  await deleteExpiredTickets(db, now);

  const next = await getFirstOrphanedAt(db);

  return { released, next: next === null ? null : next + GRACE_PERIOD };
};

/**
 * Create a single-use ticket that opens a lock connection for a user. Browsers can’t set headers on
 * a WebSocket, so the session token can’t be sent with it.
 * @param {Database} db Database.
 * @param {{ userId: string, name: string, role: string }} user User.
 * @param {number} [now] Current time.
 * @returns {Promise<string>} Ticket.
 */
export const createTicket = async (db, { userId, name, role }, now = Date.now()) => {
  const ticket = toBase64Url(crypto.getRandomValues(new Uint8Array(24)));

  await insertTicket(
    db,
    { ticket, user_id: userId, name, role, expires_at: now + TICKET_TTL },
    now,
  );

  return ticket;
};

/**
 * Use up a ticket.
 * @param {Database} db Database.
 * @param {string | null} ticket Ticket.
 * @param {number} [now] Current time.
 * @returns {Promise<Omit<LockClient, 'connection'> | undefined>} User, if the ticket is valid.
 */
export const redeemTicket = async (db, ticket, now = Date.now()) => {
  if (!ticket) {
    return undefined;
  }

  // Taken whatever it turns out to be, so a ticket can’t be tried again
  const row = await takeTicket(db, ticket);

  if (!row || Number(row.expires_at) <= now) {
    return undefined;
  }

  // The user as they are now, not as they were when the ticket was issued: they may have been
  // disabled or given another role since
  const user = await findUserRow(db, { id: row.user_id });

  return user && !user.banned
    ? { userId: user.id, name: user.name, role: /** @type {any} */ (user.role ?? 'viewer') }
    : undefined;
};

/**
 * Parse a message from a client, which must be a JSON string of a reasonable size.
 * @param {string | ArrayBuffer} data Raw message.
 * @returns {Record<string, any>} Message, or an empty object if it can’t be parsed.
 */
export const parseSocketMessage = (data) => {
  try {
    const message =
      typeof data === 'string' && data.length <= MAX_MESSAGE_SIZE ? JSON.parse(data) : null;

    return message && typeof message === 'object' ? message : {};
  } catch {
    return {};
  }
};

/**
 * Messages to send in answer to a client’s message.
 * @typedef {object} LockMessageResult
 * @property {Record<string, any>[]} reply Messages for the sender only.
 * @property {Record<string, any>[]} broadcast Messages for every connection, the sender included.
 */

/**
 * Handle a message from a client:
 * - `{ type: 'acquire', key }` acquires a lock; a refusal is answered with `refused`;
 * - `{ type: 'takeover', key }` takes it over, whoever holds it;
 * - `{ type: 'release', key }` releases it.
 *
 * Every change is broadcast as `{ type: 'changed', key, lock }`, where `lock` is `null` once it’s
 * released, so the previous holder of a lock taken over learns about it as well.
 * @param {Database} db Database.
 * @param {LockClient} client Client.
 * @param {string | ArrayBuffer} data Raw message.
 * @param {number} [now] Current time.
 * @returns {Promise<LockMessageResult>} Messages to send.
 */
export const handleLockMessage = async (db, client, data, now = Date.now()) => {
  /** @type {LockMessageResult} */
  const result = { reply: [], broadcast: [] };
  const { type, key } = parseSocketMessage(data);

  if (type === 'release') {
    if (await releaseLock(db, client, key)) {
      result.broadcast.push({ type: 'changed', key, lock: null });
    }

    return result;
  }

  if (type !== 'acquire' && type !== 'takeover') {
    result.reply.push({ type: 'error', code: 'invalid_message' });

    return result;
  }

  const outcome = await (type === 'acquire' ? acquireLock : takeOverLock)(db, client, key, now);

  if (!outcome.ok) {
    result.reply.push({
      type: 'refused',
      key,
      reason: outcome.reason,
      ...(outcome.lock ? { lock: outcome.lock } : {}),
    });
  } else if (outcome.changed) {
    result.broadcast.push({ type: 'changed', key, lock: outcome.lock });
  } else {
    result.reply.push({ type: 'changed', key, lock: outcome.lock });
  }

  return result;
};
