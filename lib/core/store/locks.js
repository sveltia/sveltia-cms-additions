/**
 * Storage of the entry locks (`lock`) and of the single-use tickets that open a tab’s connection
 * (`lock_ticket`). The rules are in `../locks.js`.
 * @import { Database } from '../../types.js';
 */

/**
 * A lock, as stored.
 * @typedef {object} LockRow
 * @property {string} key Lock key.
 * @property {string} user_id User who holds it.
 * @property {string} name User’s name.
 * @property {number} since When it was acquired.
 * @property {string} connection Connection that holds it.
 * @property {number | null} orphaned_at When its connection closed, if it has.
 */

/**
 * A ticket, as stored.
 * @typedef {object} TicketRow
 * @property {string} ticket Ticket.
 * @property {string} user_id User.
 * @property {string} name User’s name.
 * @property {string} role User’s role.
 * @property {number} expires_at Expiry date.
 */

/**
 * Get a lock.
 * @param {Database} db Database.
 * @param {string} key Lock key.
 * @returns {Promise<LockRow | undefined>} Lock.
 */
export const getLockRow = (db, key) =>
  db.selectFrom('lock').selectAll().where('key', '=', key).executeTakeFirst();

/**
 * List every lock, by key.
 * @param {Database} db Database.
 * @returns {Promise<LockRow[]>} Locks.
 */
export const listLockRows = (db) => db.selectFrom('lock').selectAll().orderBy('key').execute();

/**
 * Count a user’s locks, leaving one out.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @param {string} exceptKey Lock key to leave out.
 * @returns {Promise<number>} Count.
 */
export const countUserLockRows = async (db, userId, exceptKey) => {
  const row = await db
    .selectFrom('lock')
    .select(({ fn }) => fn.countAll().as('count'))
    .where('user_id', '=', userId)
    .where('key', '!=', exceptKey)
    .executeTakeFirst();

  return Number(row?.count ?? 0);
};

/**
 * Store a lock if it’s free, or the same user’s orphaned lock, in one statement.
 * @param {Database} db Database.
 * @param {Omit<LockRow, 'orphaned_at'>} lock Lock.
 * @returns {Promise<LockRow | undefined>} Lock, if it was stored.
 */
export const acquireLockRow = (db, lock) =>
  db
    .insertInto('lock')
    .values({ ...lock, orphaned_at: null })
    .onConflict((oc) =>
      oc
        .column('key')
        .doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          since: eb.ref('excluded.since'),
          connection: eb.ref('excluded.connection'),
          orphaned_at: null,
        }))
        .where('lock.user_id', '=', lock.user_id)
        .where('lock.orphaned_at', 'is not', null),
    )
    .returningAll()
    .executeTakeFirst();

/**
 * Store a lock, replacing whoever held it.
 * @param {Database} db Database.
 * @param {Omit<LockRow, 'orphaned_at'>} lock Lock.
 * @returns {Promise<LockRow>} Lock.
 */
export const putLockRow = async (db, lock) =>
  /** @type {LockRow} */ (
    await db
      .insertInto('lock')
      .values({ ...lock, orphaned_at: null })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet((eb) => ({
          user_id: eb.ref('excluded.user_id'),
          name: eb.ref('excluded.name'),
          since: eb.ref('excluded.since'),
          connection: eb.ref('excluded.connection'),
          orphaned_at: null,
        })),
      )
      .returningAll()
      .executeTakeFirst()
  );

/**
 * Delete a lock a user’s connection holds.
 * @param {Database} db Database.
 * @param {string} key Lock key.
 * @param {string} connection Connection ID.
 * @param {string} userId User the connection belongs to.
 * @returns {Promise<boolean>} Whether a lock was deleted.
 */
export const deleteLockRow = async (db, key, connection, userId) =>
  Number(
    (
      await db
        .deleteFrom('lock')
        .where('key', '=', key)
        .where('connection', '=', connection)
        .where('user_id', '=', userId)
        .executeTakeFirst()
    ).numDeletedRows,
  ) > 0;

/**
 * Check whether another user holds locks through a connection ID.
 * @param {Database} db Database.
 * @param {string} connection Connection ID.
 * @param {string} userId User who isn’t counted.
 * @returns {Promise<boolean>} Result.
 */
export const hasOthersLocks = async (db, connection, userId) =>
  !!(await db
    .selectFrom('lock')
    .select('key')
    .where('connection', '=', connection)
    .where('user_id', '!=', userId)
    .executeTakeFirst());

/**
 * Mark the locks of a connection as orphaned.
 * @param {Database} db Database.
 * @param {string} connection Connection ID.
 * @param {number} now Current time.
 * @returns {Promise<number>} Number of locks marked.
 */
export const orphanLockRows = async (db, connection, now) =>
  Number(
    (
      await db
        .updateTable('lock')
        .set({ orphaned_at: now })
        .where('connection', '=', connection)
        .executeTakeFirst()
    ).numUpdatedRows,
  );

/**
 * Take back the orphaned locks of a connection that turns out to be alive, e.g. a tab whose
 * heartbeats resumed after a gap.
 * @param {Database} db Database.
 * @param {string} connection Connection ID.
 * @param {string} userId User the connection belongs to.
 * @returns {Promise<void>}
 */
export const adoptLockRows = async (db, connection, userId) => {
  await db
    .updateTable('lock')
    .set({ orphaned_at: null })
    .where('connection', '=', connection)
    .where('user_id', '=', userId)
    .where('orphaned_at', 'is not', null)
    .execute();
};

/**
 * List the connections that hold locks and haven’t been closed.
 * @param {Database} db Database.
 * @returns {Promise<string[]>} Connection IDs.
 */
export const listLockConnections = async (db) =>
  (
    await db
      .selectFrom('lock')
      .select('connection')
      .distinct()
      .where('orphaned_at', 'is', null)
      .execute()
  ).map(({ connection }) => connection);

/**
 * Delete the locks orphaned at or before a given time.
 * @param {Database} db Database.
 * @param {number} cutoff Time.
 * @returns {Promise<string[]>} Keys of the deleted locks.
 */
export const deleteOrphanedLockRows = async (db, cutoff) =>
  (
    await db
      .deleteFrom('lock')
      .where('orphaned_at', 'is not', null)
      .where('orphaned_at', '<=', cutoff)
      .returning('key')
      .execute()
  ).map(({ key }) => key);

/**
 * Get when the oldest orphaned lock was orphaned.
 * @param {Database} db Database.
 * @returns {Promise<number | null>} Time, if there is any.
 */
export const getFirstOrphanedAt = async (db) => {
  const row = await db
    .selectFrom('lock')
    .select(({ fn }) => fn.min('orphaned_at').as('next'))
    .where('orphaned_at', 'is not', null)
    .executeTakeFirst();

  return row?.next == null ? null : Number(row.next);
};

/**
 * Delete the expired tickets.
 * @param {Database} db Database.
 * @param {number} now Current time.
 * @returns {Promise<void>}
 */
export const deleteExpiredTickets = async (db, now) => {
  await db.deleteFrom('lock_ticket').where('expires_at', '<=', now).execute();
};

/**
 * Store a ticket, dropping the expired ones.
 * @param {Database} db Database.
 * @param {TicketRow} ticket Ticket.
 * @param {number} now Current time.
 * @returns {Promise<void>}
 */
export const insertTicket = async (db, ticket, now) => {
  await deleteExpiredTickets(db, now);
  await db.insertInto('lock_ticket').values(ticket).execute();
};

/**
 * Take a ticket out of storage, which can only be done once.
 * @param {Database} db Database.
 * @param {string} ticket Ticket.
 * @returns {Promise<TicketRow | undefined>} Ticket, whether it’s still valid or not.
 */
export const takeTicket = (db, ticket) =>
  db.deleteFrom('lock_ticket').where('ticket', '=', ticket).returningAll().executeTakeFirst();

/**
 * Delete a user’s unused tickets, e.g. once their access has changed.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const deleteUserTickets = async (db, userId) => {
  await db.deleteFrom('lock_ticket').where('user_id', '=', userId).execute();
};
