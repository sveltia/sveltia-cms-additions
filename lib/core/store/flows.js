/**
 * Storage of the sign-ins through a provider in progress (`auth_flow`), and of the one-time codes
 * the CMS exchanges for a session (`auth_code`). The rules, e.g. what a valid flow is, are in
 * `../auth/flows.js`; this module only reads and writes the rows, with queries that work on any
 * database Kysely supports.
 * @import { Database } from '../../types.js';
 */

/**
 * A sign-in in progress, as stored.
 * @typedef {object} FlowRow
 * @property {string} state State sent to the provider, or the link reference.
 * @property {string} provider Provider, e.g. `github`, or `github-link` for a link reference.
 * @property {string} redirect_uri CMS page to return to.
 * @property {string} client_state State the CMS sent.
 * @property {string} code_challenge PKCE challenge.
 * @property {string | null} link_user_id User the identity is linked to, for a link.
 * @property {number} expires_at Expiry date.
 */

/**
 * A one-time code, as stored.
 * @typedef {object} CodeRow
 * @property {string} code_hash Hash of the code.
 * @property {string} user_id User who signed in.
 * @property {string} code_challenge PKCE challenge.
 * @property {string} redirect_uri Page it was issued for.
 * @property {number} expires_at Expiry date.
 * @property {string | null} link_ciphertext Pending link, encrypted, for a link.
 */

/**
 * Store a sign-in in progress, dropping the expired ones.
 * @param {Database} db Database.
 * @param {FlowRow} flow Flow.
 * @returns {Promise<void>}
 */
export const insertFlow = async (db, flow) => {
  await db.deleteFrom('auth_flow').where('expires_at', '<=', Date.now()).execute();
  await db.insertInto('auth_flow').values(flow).execute();
};

/**
 * Take a sign-in in progress out of storage, which can only be done once: the row is deleted and
 * returned in one statement, so two requests can’t both get it.
 * @param {Database} db Database.
 * @param {string} state State.
 * @returns {Promise<FlowRow | undefined>} Flow, whether it’s still valid or not.
 */
export const takeFlowRow = (db, state) =>
  db.deleteFrom('auth_flow').where('state', '=', state).returningAll().executeTakeFirst();

/**
 * Store a one-time code, dropping the expired ones.
 * @param {Database} db Database.
 * @param {CodeRow} code Code.
 * @returns {Promise<void>}
 */
export const insertCode = async (db, code) => {
  await db.deleteFrom('auth_code').where('expires_at', '<=', Date.now()).execute();
  await db.insertInto('auth_code').values(code).execute();
};

/**
 * Take a one-time code out of storage, which can only be done once, like {@link takeFlowRow}.
 * @param {Database} db Database.
 * @param {string} codeHash Hash of the code.
 * @returns {Promise<CodeRow | undefined>} Code, whether it’s still valid or not.
 */
export const takeCodeRow = (db, codeHash) =>
  db.deleteFrom('auth_code').where('code_hash', '=', codeHash).returningAll().executeTakeFirst();

/**
 * Delete a user’s sign-ins in progress: their link references and their unused codes.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const deleteUserFlows = async (db, userId) => {
  await db.deleteFrom('auth_flow').where('link_user_id', '=', userId).execute();
  await db.deleteFrom('auth_code').where('user_id', '=', userId).execute();
};
