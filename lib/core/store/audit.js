/**
 * Storage of the audit log (`audit_log`).
 * @import { Database } from '../../types.js';
 */

/**
 * Add an event to the audit log.
 * @param {Database} db Database.
 * @param {object} event Event.
 * @param {string} event.action What happened.
 * @param {string | null} event.actor_id ID of the user who did it.
 * @param {string | null} event.target What it happened to.
 * @param {string | null} event.meta Extra details, as JSON.
 * @returns {Promise<void>}
 */
export const insertAuditEvent = async (db, event) => {
  await db
    .insertInto('audit_log')
    .values({ at: Date.now(), ...event })
    .execute();
};
