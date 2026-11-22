/**
 * Storage of the identities users sign in with on a Git provider (`provider_account`), keyed on the
 * provider and the user’s immutable ID there, with the refresh token of the user’s own token,
 * encrypted.
 * @import { Database } from '../../types.js';
 */

/**
 * A user’s identity on a provider.
 * @typedef {object} ProviderAccount
 * @property {string} user_id User ID.
 * @property {string} provider Provider ID, e.g. `github`.
 * @property {string} external_id The provider’s immutable ID of the user, as a string.
 * @property {string} login Username on the provider, as of the last sign-in.
 * @property {string | null} refresh_token_ciphertext Encrypted refresh token, if any.
 * @property {number | null} refresh_token_expires_at Expiry of the refresh token.
 * @property {number} created_at When it was recorded.
 * @property {number | null} first_signed_in_at When the user first signed in with it, or `null`
 * while an admin’s claim is waiting for it.
 */

/**
 * Find an identity by user or by the provider’s ID of the user.
 * @param {Database} db Database.
 * @param {string} provider Provider ID.
 * @param {{ userId: string } | { externalId: string }} by What to look up.
 * @returns {Promise<ProviderAccount | null>} Identity.
 */
export const findProviderAccountRow = async (db, provider, by) => {
  const query = db.selectFrom('provider_account').selectAll().where('provider', '=', provider);

  return (
    (await (
      'userId' in by
        ? query.where('user_id', '=', by.userId)
        : query.where('external_id', '=', by.externalId)
    ).executeTakeFirst()) ?? null
  );
};

/**
 * Unbind a user’s identity on a provider.
 * @param {Database} db Database.
 * @param {string} provider Provider ID.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const deleteProviderAccount = async (db, provider, userId) => {
  await db
    .deleteFrom('provider_account')
    .where('provider', '=', provider)
    .where('user_id', '=', userId)
    .execute();
};

/**
 * Bind an identity to a user, replacing any other they had on the provider, with its refresh token
 * and first sign-in. One statement, so if another user has the identity, the user keeps the one
 * they had.
 * @param {Database} db Database.
 * @param {{ userId: string, provider: string, externalId: string, login: string }} account
 * Identity.
 * @returns {Promise<void>}
 */
export const replaceProviderAccount = async (db, { userId, provider, externalId, login }) => {
  await db
    .insertInto('provider_account')
    .values({
      user_id: userId,
      provider,
      external_id: externalId,
      login,
      refresh_token_ciphertext: null,
      refresh_token_expires_at: null,
      created_at: Date.now(),
      first_signed_in_at: null,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'provider']).doUpdateSet((eb) => ({
        external_id: eb.ref('excluded.external_id'),
        login: eb.ref('excluded.login'),
        refresh_token_ciphertext: null,
        refresh_token_expires_at: null,
        created_at: eb.ref('excluded.created_at'),
        first_signed_in_at: null,
      })),
    )
    .execute();
};

/**
 * Keep a user’s refresh token, or drop it, and record their first sign-in.
 * @param {Database} db Database.
 * @param {string} provider Provider ID.
 * @param {string} userId User ID.
 * @param {{ ciphertext: string, expiresAt: number } | null} refreshToken Refresh token, encrypted.
 * @returns {Promise<void>}
 */
export const updateRefreshToken = async (db, provider, userId, refreshToken) => {
  await db
    .updateTable('provider_account')
    .set(({ fn, val }) => ({
      refresh_token_ciphertext: refreshToken?.ciphertext ?? null,
      refresh_token_expires_at: refreshToken?.expiresAt ?? null,
      first_signed_in_at: fn.coalesce('first_signed_in_at', val(Date.now())),
    }))
    .where('provider', '=', provider)
    .where('user_id', '=', userId)
    .execute();
};

/**
 * Drop a user’s refresh token.
 * @param {Database} db Database.
 * @param {string} provider Provider ID.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const deleteRefreshToken = async (db, provider, userId) => {
  await db
    .updateTable('provider_account')
    .set({ refresh_token_ciphertext: null, refresh_token_expires_at: null })
    .where('provider', '=', provider)
    .where('user_id', '=', userId)
    .execute();
};

/**
 * Keep a user’s username on a provider current, as it can change there.
 * @param {Database} db Database.
 * @param {string} provider Provider ID.
 * @param {string} userId User ID.
 * @param {string} login Username.
 * @returns {Promise<void>}
 */
export const updateProviderLogin = async (db, provider, userId, login) => {
  await db
    .updateTable('provider_account')
    .set({ login })
    .where('provider', '=', provider)
    .where('user_id', '=', userId)
    .execute();
};
