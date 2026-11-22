/**
 * Storage of the Git tokens handed to users (`issued_token`), encrypted, so they can be reused and
 * revoked before they expire. Rows are deleted once the token has expired.
 * @import { Database } from '../../types.js';
 */

/**
 * A token, as stored.
 * @typedef {object} TokenRow
 * @property {string} id ID.
 * @property {string} user_id User it was handed to.
 * @property {string | null} session_id Session it was handed to, for an installation token.
 * @property {'installation' | 'user'} kind Kind: an installation token, or the user’s own token.
 * @property {string} role Role it was minted for.
 * @property {string} token_hash Hash of the token.
 * @property {string} token_ciphertext Token, encrypted.
 * @property {number} issued_at Issue date.
 * @property {number} expires_at Expiry date.
 */

/**
 * Whose tokens to revoke: a user’s, possibly of one kind only, a session’s, or everyone’s.
 * @typedef {{ userId: string, kind?: 'installation' | 'user' } | { sessionId: string } |
 * { everyone: true }} TokenTarget
 */

/**
 * Store a token.
 * @param {Database} db Database.
 * @param {TokenRow} row Token.
 * @returns {Promise<void>}
 */
export const insertToken = async (db, row) => {
  await db.insertInto('issued_token').values(row).execute();
};

/**
 * Find the token that expires last among those of a session for a role, or of a user’s own, that
 * aren’t being revoked and are still valid at the given date.
 * @param {Database} db Database.
 * @param {{ sessionId: string, role: string } | { userId: string }} owner Session and role, for an
 * installation token, or user, for their own token.
 * @param {number} validUntil Date the token must still be valid at.
 * @returns {Promise<Pick<TokenRow, 'id' | 'token_ciphertext' | 'expires_at'> | undefined>} Token.
 */
export const findUsableToken = (db, owner, validUntil) => {
  let query = db
    .selectFrom('issued_token')
    .select(['id', 'token_ciphertext', 'expires_at'])
    .where('revoke_requested_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', validUntil);

  query =
    'sessionId' in owner
      ? query.where('session_id', '=', owner.sessionId).where('role', '=', owner.role)
      : query.where('user_id', '=', owner.userId).where('kind', '=', 'user');

  return query.orderBy('expires_at', 'desc').limit(1).executeTakeFirst();
};

/**
 * Delete the tokens that have expired.
 * @param {Database} db Database.
 * @param {number} [now] Current time.
 * @param {object} [options] Options.
 * @param {boolean} [options.keepPending] Whether to keep those waiting to be revoked, for
 * `revokePendingTokens`, which drops the refresh token of a user whose own token expired before
 * it could be revoked.
 * @returns {Promise<void>}
 */
export const deleteExpiredTokens = async (db, now = Date.now(), { keepPending = false } = {}) => {
  let query = db.deleteFrom('issued_token').where('expires_at', '<=', now);

  if (keepPending) {
    query = query.where(({ or, eb }) =>
      or([eb('revoke_requested_at', 'is', null), eb('revoked_at', 'is not', null)]),
    );
  }

  await query.execute();
};

/**
 * Check whether a user’s own token is waiting to be revoked.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<boolean>} Result.
 */
export const hasPendingUserRevocation = async (db, userId) =>
  !!(await db
    .selectFrom('issued_token')
    .select('id')
    .where('user_id', '=', userId)
    .where('kind', '=', 'user')
    .where('revoke_requested_at', 'is not', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst());

/**
 * Check whether a user has an own token that hasn’t expired.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @param {number} [now] Current time.
 * @returns {Promise<boolean>} Result.
 */
export const hasLiveUserToken = async (db, userId, now = Date.now()) =>
  !!(await db
    .selectFrom('issued_token')
    .select('id')
    .where('user_id', '=', userId)
    .where('kind', '=', 'user')
    .where('expires_at', '>', now)
    .executeTakeFirst());

/**
 * Record that every own token of a user has been revoked, e.g. once their authorization of the
 * service is revoked, which takes all of them with it.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const markUserTokensRevoked = async (db, userId) => {
  const now = Date.now();

  await db
    .updateTable('issued_token')
    .set(({ fn, val }) => ({
      revoke_requested_at: fn.coalesce('revoke_requested_at', val(now)),
      revoked_at: now,
    }))
    .where('user_id', '=', userId)
    .where('kind', '=', 'user')
    .where('revoked_at', 'is', null)
    .execute();
};

/**
 * Mark a token for revocation.
 * @param {Database} db Database.
 * @param {string} id Token ID.
 * @returns {Promise<void>}
 */
export const markTokenForRevocation = async (db, id) => {
  await db
    .updateTable('issued_token')
    .set({ revoke_requested_at: Date.now() })
    .where('id', '=', id)
    .where('revoke_requested_at', 'is', null)
    .execute();
};

/**
 * Delete every token, e.g. when the GitHub App is set up again from scratch.
 * @param {Database} db Database.
 * @returns {Promise<void>}
 */
export const deleteAllTokens = async (db) => {
  await db.deleteFrom('issued_token').execute();
};

/**
 * Find the users whose own token expired before it could be revoked, and who haven’t been handed a
 * newer one since.
 * @param {Database} db Database.
 * @param {number} now Current time.
 * @returns {Promise<string[]>} User IDs.
 */
export const findStrandedTokenUsers = async (db, now) =>
  (
    await db
      .selectFrom('issued_token as t')
      .select('t.user_id')
      .distinct()
      .where('t.kind', '=', 'user')
      .where('t.revoke_requested_at', 'is not', null)
      .where('t.revoked_at', 'is', null)
      .where('t.expires_at', '<=', now)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('issued_token as n')
              .select('n.id')
              .whereRef('n.user_id', '=', 't.user_id')
              .where('n.kind', '=', 'user')
              .whereRef('n.issued_at', '>', 't.issued_at'),
          ),
        ),
      )
      .execute()
  ).map(({ user_id: userId }) => userId);

/**
 * List the tokens waiting to be revoked, the oldest requests first.
 * @param {Database} db Database.
 * @param {number} limit Maximum number of tokens.
 * @returns {Promise<Pick<TokenRow, 'id' | 'user_id' | 'kind' | 'token_ciphertext'>[]>} Tokens.
 */
export const listPendingRevocations = (db, limit) =>
  db
    .selectFrom('issued_token')
    .select(['id', 'user_id', 'kind', 'token_ciphertext'])
    .where('revoke_requested_at', 'is not', null)
    .where('revoked_at', 'is', null)
    .orderBy('revoke_requested_at')
    .limit(limit)
    .execute();

/**
 * Record that a token has been revoked.
 * @param {Database} db Database.
 * @param {string} id Token ID.
 * @returns {Promise<void>}
 */
export const markTokenRevoked = async (db, id) => {
  await db
    .updateTable('issued_token')
    .set({ revoked_at: Date.now() })
    .where('id', '=', id)
    .execute();
};

/**
 * Mark the valid tokens of a user, a session or everyone for revocation.
 * @param {Database} db Database.
 * @param {TokenTarget} target Whose tokens.
 * @returns {Promise<void>}
 */
export const markTokensForRevocation = async (db, target) => {
  const now = Date.now();

  let query = db
    .updateTable('issued_token')
    .set({ revoke_requested_at: now })
    .where('revoked_at', 'is', null)
    .where('revoke_requested_at', 'is', null)
    .where('expires_at', '>', now);

  if ('userId' in target) {
    query = query.where('user_id', '=', target.userId);

    if (target.kind) {
      query = query.where('kind', '=', target.kind);
    }
  } else if ('sessionId' in target) {
    query = query.where('session_id', '=', target.sessionId);
  }

  await query.execute();
};

/**
 * Count the tokens waiting to be revoked, per user.
 * @param {Database} db Database.
 * @returns {Promise<Map<string, number>>} Counts by user ID.
 */
export const countPendingRevocationsByUser = async (db) =>
  new Map(
    (
      await db
        .selectFrom('issued_token')
        .select(({ fn }) => ['user_id', fn.countAll().as('count')])
        .where('revoke_requested_at', 'is not', null)
        .where('revoked_at', 'is', null)
        .groupBy('user_id')
        .execute()
    ).map(({ user_id: userId, count }) => [userId, Number(count)]),
  );

/**
 * Count the tokens waiting to be revoked.
 * @param {Database} db Database.
 * @returns {Promise<number>} Count.
 */
export const countPendingRevocations = async (db) => {
  const row = await db
    .selectFrom('issued_token')
    .select(({ fn }) => fn.countAll().as('count'))
    .where('revoke_requested_at', 'is not', null)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();

  return Number(row?.count ?? 0);
};
