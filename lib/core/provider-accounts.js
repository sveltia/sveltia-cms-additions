import { decryptValue, encryptValue } from './crypto/data-key.js';
import { toBase64Url, toUtf8 } from './crypto/encoding.js';
import { ProviderError } from './git-provider.js';
import { HttpError } from './http/errors.js';
import {
  deleteRefreshToken,
  findProviderAccountRow,
  replaceProviderAccount,
  updateRefreshToken,
} from './store/provider-accounts.js';
import { findUsableToken, hasPendingUserRevocation, insertToken } from './store/tokens.js';

/**
 * The identities users sign in with on the site’s Git provider, and their own tokens there.
 * @import { Database, DataKeys } from '../types.js';
 * @import { GitProvider, UserTokens } from './git-provider.js';
 * @import { ProviderAccount } from './store/provider-accounts.js';
 */

/**
 * A user’s own token is replaced when it has less than this left.
 */
const MIN_REMAINING_LIFETIME = 10 * 60 * 1000;

/**
 * Get the AAD of a stored refresh token. GitHub’s keeps the name of the table it was first stored
 * in, so the tokens stored then can still be decrypted.
 * @param {string} provider Provider ID.
 * @param {string} userId User ID.
 * @returns {string} AAD.
 */
const getRefreshTokenAad = (provider, userId) =>
  provider === 'github'
    ? `github_account:refresh_token_ciphertext:${userId}`
    : `provider_account:refresh_token_ciphertext:${provider}:${userId}`;

/**
 * Get the AAD of an issued token.
 * @param {string} id Row ID.
 * @returns {string} AAD.
 */
const getIssuedTokenAad = (id) => `issued_token:token_ciphertext:${id}`;

/**
 * Hash a token for lookups without decrypting.
 * @param {string} token Token.
 * @returns {Promise<string>} Hash.
 */
export const hashToken = async (token) =>
  toBase64Url(await crypto.subtle.digest('SHA-256', toUtf8(token)));

/**
 * Bind an identity on a provider to a user, replacing any other they had there. From then on, only
 * that identity signs in to the account with the provider.
 * @param {Database} db Database.
 * @param {string} provider Provider ID.
 * @param {{ userId: string, externalId: string, login: string }} account Identity.
 * @returns {Promise<void>}
 * @throws {HttpError} If another user has the identity.
 */
export const claimProviderAccount = async (db, provider, { userId, externalId, login }) => {
  const owner = await findProviderAccountRow(db, provider, { externalId });

  /**
   * Create the error for an identity another user has.
   * @returns {HttpError} Error.
   */
  const taken = () =>
    // The code predates other providers, and the CMS knows it
    new HttpError(409, 'github_account_taken', 'Another user signs in with this account.');

  if (owner && owner.user_id !== userId) {
    throw taken();
  }

  if (owner) {
    return;
  }

  try {
    await replaceProviderAccount(db, { userId, provider, externalId, login });
  } catch (error) {
    // Another request has claimed the identity since it was checked
    if (/UNIQUE/i.test(String(/** @type {any} */ (error)?.message))) {
      throw taken();
    }

    throw error;
  }
};

/**
 * Record a user’s own token, so it can be reused and revoked, and keep its refresh token.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} provider Provider ID.
 * @param {string} userId User ID.
 * @param {UserTokens} tokens Tokens.
 * @returns {Promise<void>}
 */
export const storeUserTokens = async (db, keys, provider, userId, tokens) => {
  const id = crypto.randomUUID();

  await insertToken(db, {
    id,
    user_id: userId,
    session_id: null,
    kind: 'user',
    // A user’s own token can do whatever the user can on the provider, whatever their role here
    role: provider,
    token_hash: await hashToken(tokens.accessToken),
    token_ciphertext: await encryptValue(keys, tokens.accessToken, getIssuedTokenAad(id)),
    issued_at: Date.now(),
    expires_at: Date.parse(tokens.expiresAt),
  });

  await updateRefreshToken(
    db,
    provider,
    userId,
    tokens.refreshToken
      ? {
          ciphertext: await encryptValue(
            keys,
            tokens.refreshToken,
            getRefreshTokenAad(provider, userId),
          ),
          expiresAt: Date.parse(/** @type {string} */ (tokens.refreshTokenExpiresAt)),
        }
      : null,
  );
};

/**
 * Get a user’s stored own token that still has enough time left.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} userId User ID.
 * @returns {Promise<{ token: string, expires_at: string } | null>} Token.
 */
const findUsableUserToken = async (db, keys, userId) => {
  const row = await findUsableToken(db, { userId }, Date.now() + MIN_REMAINING_LIFETIME);

  const token = row
    ? await decryptValue(keys, row.token_ciphertext, getIssuedTokenAad(row.id))
    : null;

  return token ? { token, expires_at: new Date(row.expires_at).toISOString() } : null;
};

/**
 * Check whether a user has a refresh token that can still be used.
 * @param {ProviderAccount | null} account Identity.
 * @returns {boolean} Result.
 */
const canRefresh = (account) =>
  !!account?.refresh_token_ciphertext &&
  /** @type {number} */ (account.refresh_token_expires_at) > Date.now();

/**
 * Refresh a user’s own token. A refresh token can only be used once, so concurrent refreshes would
 * fail but for the first one: callers run this one at a time per user, and it returns a token
 * another call has just refreshed instead of refreshing again.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {GitProvider} provider Provider.
 * @param {string} userId User ID.
 * @returns {Promise<{ token: string, expires_at: string } | null>} Token, or `null` if it can’t be
 * refreshed, e.g. because the user revoked the service’s authorization on the provider.
 */
export const refreshUserToken = async (db, keys, provider, userId) => {
  const usable = await findUsableUserToken(db, keys, userId);

  if (usable) {
    return usable;
  }

  if (await hasPendingUserRevocation(db, userId)) {
    return null;
  }

  const [account, connection] = await Promise.all([
    findProviderAccountRow(db, provider.id, { userId }),
    provider.connect(db, keys),
  ]);

  if (!connection || !account || !canRefresh(account)) {
    return null;
  }

  const refreshToken = await decryptValue(
    keys,
    /** @type {string} */ (account.refresh_token_ciphertext),
    getRefreshTokenAad(provider.id, userId),
  );

  // It can’t be decrypted after a re-key; the user signs in with the provider again
  if (!refreshToken) {
    await deleteRefreshToken(db, provider.id, userId);

    return null;
  }

  /** @type {UserTokens} */
  let tokens;

  try {
    tokens = await connection.signIn.refreshTokens(refreshToken);
  } catch (error) {
    // The provider refused the refresh token, which is spent or revoked: the user signs in with it
    // again. One that couldn’t be tried, as the provider couldn’t be reached or failed, is kept for
    // later
    if (error instanceof ProviderError && error.providerStatus < 500) {
      await deleteRefreshToken(db, provider.id, userId);
    }

    return null;
  }

  await storeUserTokens(db, keys, provider.id, userId, tokens);

  return { token: tokens.accessToken, expires_at: tokens.expiresAt };
};

/**
 * Get a user’s own token for a user who signed in with the provider, reusing the current one while
 * it has enough time left and refreshing it otherwise.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} provider Provider ID.
 * @param {string} userId User ID.
 * @param {() => Promise<{ token: string, expires_at: string } | null>} refresh Function that runs
 * {@link refreshUserToken} one call at a time for the user.
 * @returns {Promise<{ token: string, expires_at: string } | null>} Token, or `null` if the user has
 * none, e.g. a password user.
 */
export const getUserToken = async (db, keys, provider, userId, refresh) => {
  const usable = await findUsableUserToken(db, keys, userId);

  if (usable) {
    return usable;
  }

  // While their own tokens are waiting to be revoked, e.g. after they were signed out everywhere,
  // the user gets a minted token instead of a refreshed one, which the revocation would kill
  if (await hasPendingUserRevocation(db, userId)) {
    return null;
  }

  return canRefresh(await findProviderAccountRow(db, provider, { userId })) ? refresh() : null;
};
