/**
 * Storage of the GitHub App setup runs in progress (`setup_state`), which carry the `state` of the
 * manifest and installation flows.
 * @import { Database } from '../../types.js';
 */

/**
 * A setup run, as stored.
 * @typedef {object} SetupStateRow
 * @property {string} state State.
 * @property {string} stage Stage: `manifest` while the app is registered, `creating` while its
 * credentials are stored, `install` while it’s installed.
 * @property {string} repo Repository, as `owner/name`.
 * @property {string} return_url CMS page to return to.
 * @property {number} created_at Creation date.
 * @property {number} expires_at Expiry date.
 */

/**
 * Store a setup run, dropping the expired ones.
 * @param {Database} db Database.
 * @param {SetupStateRow} row Setup run.
 * @returns {Promise<void>}
 */
export const insertSetupState = async (db, row) => {
  await db.insertInto('setup_state').values(row).execute();
  await db.deleteFrom('setup_state').where('expires_at', '<=', row.created_at).execute();
};

/**
 * Get a setup run at a given stage that hasn’t expired.
 * @param {Database} db Database.
 * @param {string} state State.
 * @param {string} stage Stage.
 * @returns {Promise<SetupStateRow | undefined>} Setup run.
 */
export const findSetupState = (db, state, stage) =>
  db
    .selectFrom('setup_state')
    .selectAll()
    .where('state', '=', state)
    .where('stage', '=', stage)
    .where('expires_at', '>', Date.now())
    .executeTakeFirst();

/**
 * Move a setup run that hasn’t expired from one stage to the next, in one statement, so only one
 * request can.
 * @param {Database} db Database.
 * @param {string} state State.
 * @param {string} from Current stage.
 * @param {string} to Next stage.
 * @returns {Promise<SetupStateRow | undefined>} Setup run, if it was at the given stage.
 */
export const advanceSetupState = (db, state, from, to) =>
  db
    .updateTable('setup_state')
    .set({ stage: to })
    .where('state', '=', state)
    .where('stage', '=', from)
    .where('expires_at', '>', Date.now())
    .returningAll()
    .executeTakeFirst();

/**
 * Delete a setup run, once it’s complete.
 * @param {Database} db Database.
 * @param {string} state State.
 * @returns {Promise<void>}
 */
export const deleteSetupState = async (db, state) => {
  await db.deleteFrom('setup_state').where('state', '=', state).execute();
};
