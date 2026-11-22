/**
 * Storage of who has which entries open (`presence`), for platforms without live updates, where
 * each CMS tab sends a heartbeat with its open entries instead of keeping a connection open.
 * @import { Database } from '../../types.js';
 */

/**
 * A tab’s heartbeat, as stored.
 * @typedef {object} PresenceRow
 * @property {string} connection Tab ID.
 * @property {string} user_id User.
 * @property {string} name User’s name.
 * @property {string} open Keys of the open entries, as JSON.
 * @property {number} seen_at Time of the last heartbeat.
 */

/**
 * Record a tab’s heartbeat, unless the tab ID belongs to another user.
 * @param {Database} db Database.
 * @param {PresenceRow} row Heartbeat.
 * @returns {Promise<boolean>} Whether it was recorded.
 */
export const putPresenceRow = async (db, row) =>
  !!(await db
    .insertInto('presence')
    .values(row)
    .onConflict((oc) =>
      oc
        .column('connection')
        .doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          open: eb.ref('excluded.open'),
          seen_at: eb.ref('excluded.seen_at'),
        }))
        .where('presence.user_id', '=', row.user_id),
    )
    .returning('connection')
    .executeTakeFirst());

/**
 * Get a tab’s heartbeat.
 * @param {Database} db Database.
 * @param {string} connection Tab ID.
 * @returns {Promise<PresenceRow | undefined>} Heartbeat.
 */
export const getPresenceRow = (db, connection) =>
  db.selectFrom('presence').selectAll().where('connection', '=', connection).executeTakeFirst();

/**
 * List the tabs that have sent a heartbeat since a given time.
 * @param {Database} db Database.
 * @param {number} since Time.
 * @returns {Promise<PresenceRow[]>} Heartbeats.
 */
export const listPresenceRows = (db, since) =>
  db.selectFrom('presence').selectAll().where('seen_at', '>=', since).execute();

/**
 * Delete a tab’s heartbeat, e.g. as it closes, or a user’s.
 * @param {Database} db Database.
 * @param {{ connection: string } | { userId: string }} by Whose.
 * @returns {Promise<void>}
 */
export const deletePresenceRows = async (db, by) => {
  const query = db.deleteFrom('presence');

  await (
    'connection' in by
      ? query.where('connection', '=', by.connection)
      : query.where('user_id', '=', by.userId)
  ).execute();
};

/**
 * Delete the heartbeats older than a given time.
 * @param {Database} db Database.
 * @param {number} before Time.
 * @returns {Promise<void>}
 */
export const deleteStalePresenceRows = async (db, before) => {
  await db.deleteFrom('presence').where('seen_at', '<', before).execute();
};
