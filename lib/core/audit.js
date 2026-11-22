import { insertAuditEvent } from './store/audit.js';

/**
 * @import { Database } from '../types.js';
 */

/**
 * Record an event in the audit log.
 * @param {Database} db Database.
 * @param {object} event Event.
 * @param {string} event.action What happened, e.g. `data_key.rekey`.
 * @param {string | null} [event.actorId] ID of the user who did it. `null` for the admin secret or
 * the system.
 * @param {string | null} [event.target] What it happened to, e.g. a user ID.
 * @param {Record<string, any>} [event.meta] Extra details. Never include secrets.
 * @returns {Promise<void>}
 */
export const logAudit = async (db, { action, actorId = null, target = null, meta }) => {
  await insertAuditEvent(db, {
    action,
    actor_id: actorId,
    target,
    meta: meta ? JSON.stringify(meta) : null,
  });
};
