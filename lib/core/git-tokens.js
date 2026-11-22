import { getAdminSecretStatus } from './admin-secret.js';
import { toPublicUser } from './auth/users.js';
import { decryptValue, encryptValue, getDataKeys } from './crypto/data-key.js';
import { HttpError } from './http/errors.js';
import { getUserToken, hashToken } from './provider-accounts.js';
import { deleteJobRow, getJobRow, putJobRow } from './store/jobs.js';
import { deleteRefreshToken } from './store/provider-accounts.js';
import {
  countPendingRevocations,
  deleteExpiredTokens,
  findStrandedTokenUsers,
  findUsableToken,
  hasLiveUserToken,
  insertToken,
  listPendingRevocations,
  markTokenForRevocation,
  markTokenRevoked,
  markTokensForRevocation,
  markUserTokensRevoked,
} from './store/tokens.js';
import { findUserRow, sessionExists } from './store/users.js';

/**
 * @import { Database, DataKeys } from '../types.js';
 * @import { GitProvider } from './git-provider.js';
 * @import { TokenTarget } from './store/tokens.js';
 */

/**
 * Git token handed to the CMS.
 * @typedef {object} GitToken
 * @property {'installation' | 'user'} kind Token kind: a token the service minted, limited to the
 * repository and the role, or the user’s own token on the provider, for someone who signed in
 * with it.
 * @property {string} provider Git provider, e.g. `github`, whose backend the CMS uses the token
 * with.
 * @property {string} token Token.
 * @property {string} expires_at Expiry, as ISO 8601.
 * @property {string} repository Repository, as `owner/name`.
 * @property {Record<string, string>} permissions Granted permissions.
 */

/**
 * A token is replaced when it has less than this left, so the CMS never holds one about to expire.
 */
const MIN_REMAINING_LIFETIME = 10 * 60 * 1000;

/**
 * Most tokens revoked in one go. Workers on the Free plan may make 50 outgoing requests per invocation.
 */
const REVOCATION_BATCH_SIZE = 40;

/**
 * Get the AAD of a stored token.
 * @param {string} id Row ID.
 * @returns {string} AAD.
 */
const getAad = (id) => `issued_token:token_ciphertext:${id}`;

/**
 * Check whether a user may still have a token for a session and role: the session hasn’t ended,
 * and the user isn’t disabled and still has the role.
 * @param {Database} db Database.
 * @param {{ userId: string, sessionId: string, role: string }} args Arguments.
 * @returns {Promise<boolean>} Result.
 */
const isStillEntitled = async (db, { userId, sessionId, role }) => {
  const [user, session] = await Promise.all([
    findUserRow(db, { id: userId }),
    sessionExists(db, sessionId),
  ]);

  // The role as the session sees it, an unknown one counting as a viewer’s
  return !!user && !user.banned && toPublicUser(user).role === role && session;
};

/**
 * Get a Git token for a user’s session, reusing the last one while it has enough time left, or
 * minting a new one limited to the site’s repository and the user’s role. Every token is recorded,
 * encrypted, so it can be revoked later.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {GitProvider} provider The site’s Git provider.
 * @param {object} args Arguments.
 * @param {string} args.userId User ID.
 * @param {string} args.sessionId Session ID.
 * @param {string} args.role User’s role.
 * @param {() => Promise<{ token: string, expires_at: string } | null>} [args.refreshUserToken]
 * Function that refreshes the user’s own token one call at a time. Someone who signed in with the
 * provider gets that token instead of a minted one, until it can’t be refreshed.
 * @returns {Promise<GitToken | null>} Token, or `null` if the provider isn’t set up.
 */
export const getGitToken = async (
  db,
  keys,
  provider,
  { userId, sessionId, role, refreshUserToken },
) => {
  const connection = await provider.connect(db, keys);

  if (!connection) {
    return null;
  }

  const { repository } = connection;
  const permissions = connection.getPermissions(role);

  const userToken = refreshUserToken
    ? await getUserToken(db, keys, provider.id, userId, refreshUserToken)
    : null;

  // The provider decides what the user can do with their own token
  if (userToken) {
    return { kind: 'user', provider: provider.id, ...userToken, repository, permissions: {} };
  }

  const existing = await findUsableToken(
    db,
    { sessionId, role },
    Date.now() + MIN_REMAINING_LIFETIME,
  );

  if (existing) {
    const token = await decryptValue(keys, existing.token_ciphertext, getAad(existing.id));

    if (token) {
      return {
        kind: 'installation',
        provider: provider.id,
        token,
        expires_at: new Date(existing.expires_at).toISOString(),
        repository,
        permissions,
      };
    }
  }

  const minted = await connection.issueToken(role);
  const id = crypto.randomUUID();

  await insertToken(db, {
    id,
    user_id: userId,
    session_id: sessionId,
    kind: 'installation',
    role,
    token_hash: await hashToken(minted.token),
    token_ciphertext: await encryptValue(keys, minted.token, getAad(id)),
    issued_at: Date.now(),
    expires_at: Date.parse(minted.expiresAt),
  });

  // Minting waits for the provider, and other requests can run meanwhile: one may have disabled the
  // user, changed their role or ended the session, marking their tokens for revocation before this
  // one was stored. Such a token is revoked rather than handed out
  if (!(await isStillEntitled(db, { userId, sessionId, role }))) {
    if (await provider.revokeToken(minted.token).catch(() => false)) {
      await markTokenRevoked(db, id);
    } else {
      await markTokenForRevocation(db, id);
    }

    throw new HttpError(401, 'unauthenticated', 'Your access has changed. Sign in again.');
  }

  // Tokens are only kept while they could still be used, but those waiting to be revoked are left
  // to `revokePendingTokens`
  await deleteExpiredTokens(db, Date.now(), { keepPending: true });

  return {
    kind: 'installation',
    provider: provider.id,
    token: minted.token,
    expires_at: minted.expiresAt,
    repository: minted.repository,
    permissions: minted.permissions,
  };
};

/**
 * Revoke the tokens marked for revocation.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {GitProvider} provider The site’s Git provider.
 * @returns {Promise<number>} Number of tokens still pending, to be retried later.
 */
export const revokePendingTokens = async (db, keys, provider) => {
  const now = Date.now();

  // A user’s authorization of the service outlives their access token, which can’t revoke it once
  // it has expired: the refresh token that would bring it back is dropped instead, unless they have
  // signed in with the provider again since, which has stored a new one
  const stranded = await findStrandedTokenUsers(db, now);

  await Promise.all(stranded.map((userId) => deleteRefreshToken(db, provider.id, userId)));

  // Expired tokens no longer need revoking
  await deleteExpiredTokens(db, now);

  const rows = await listPendingRevocations(db, REVOCATION_BATCH_SIZE);

  // Revoking a user’s own token takes the service’s OAuth credentials
  const connection = rows.some(({ kind }) => kind === 'user')
    ? await provider.connect(db, keys)
    : null;

  await Promise.all(
    rows.map(async ({ id, user_id: userId, kind, token_ciphertext: ciphertext }) => {
      const token = await decryptValue(keys, ciphertext, getAad(id));
      /** @type {boolean} */
      let revoked;

      if (!token) {
        // A token that can’t be decrypted any more, after a re-key, can only expire on its own
        revoked = true;
      } else if (kind === 'user') {
        // This revokes the user’s authorization of the service, and with it every token it issued
        // them. Without the connection, e.g. while it’s being replaced, it waits for it to be set
        // up again
        revoked = connection ? await connection.signIn.revokeGrant(token) : false;

        if (revoked) {
          await deleteRefreshToken(db, provider.id, userId);
          // The grant took every token it issued with it, including any newer one, e.g. from a
          // sign-in while this revocation was waiting, which mustn’t be handed out any more
          await markUserTokensRevoked(db, userId);
        }
      } else {
        revoked = await provider.revokeToken(token);
      }

      if (revoked) {
        await markTokenRevoked(db, id);
      }
    }),
  );

  return countPendingRevocations(db);
};

/**
 * Mark tokens for revocation and revoke as many as possible right away. Tokens that couldn’t be
 * revoked, e.g. because the provider was unreachable, stay pending for {@link revokePendingTokens}.
 * @param {Database} db Database.
 * @param {DataKeys | undefined} keys Keys derived from the data key. Without them, the tokens are
 * only marked, and expire on their own within an hour.
 * @param {GitProvider} provider The site’s Git provider.
 * @param {TokenTarget} target Whose tokens to revoke: a user’s, a session’s, or everyone’s, e.g.
 * before the GitHub App is replaced. With `kind`, only the user’s tokens of that kind are, e.g.
 * the minted ones after a role change, which doesn’t change what their own token can do.
 * @returns {Promise<number>} Number of tokens still pending.
 */
export const revokeGitTokens = async (db, keys, provider, target) => {
  await markTokensForRevocation(db, target);

  // A user whose own token has expired has nothing left to revoke, but their refresh token would
  // bring one back: it’s dropped instead
  if ('userId' in target && target.kind !== 'installation') {
    if (!(await hasLiveUserToken(db, target.userId))) {
      await deleteRefreshToken(db, provider.id, target.userId);
    }
  }

  return keys ? revokePendingTokens(db, keys, provider) : 0;
};

/**
 * Name of the job that retries the token revocations.
 */
const TOKEN_REVOCATION_JOB = 'token_revocation';

/**
 * How long after a request the token revocations it couldn’t make are tried again.
 */
const TOKEN_REVOCATION_DELAY = 60 * 1000;

/**
 * Longest wait between two attempts, while the provider keeps failing.
 */
const MAX_TOKEN_REVOCATION_DELAY = 15 * 60 * 1000;

/**
 * How long overdue a retry can be before it’s scheduled again, e.g. as a run gave up after failing.
 */
const OVERDUE_AFTER = 60 * 60 * 1000;

/**
 * Schedule a retry of the token revocations in a minute, unless one is scheduled already.
 * @param {Database} db Database.
 * @returns {Promise<number | null>} Time of the retry, if this call scheduled it.
 */
export const scheduleTokenRevocation = async (db) => {
  const scheduled = await getJobRow(db, TOKEN_REVOCATION_JOB);

  if (scheduled && scheduled.due_at >= Date.now() - OVERDUE_AFTER) {
    return null;
  }

  const at = Date.now() + TOKEN_REVOCATION_DELAY;

  await putJobRow(db, { name: TOKEN_REVOCATION_JOB, due_at: at, attempts: 0 });

  return at;
};

/**
 * Retry revoking the pending tokens, if a retry is due, backing off up to 15 minutes between
 * attempts while the provider keeps failing. Tokens expire within an hour anyway, so the retries
 * stop on their own.
 * @param {Database} db Database.
 * @param {string | undefined} adminSecret `ADMIN_SECRET`, which unlocks the data key.
 * @param {GitProvider} provider The site’s Git provider.
 * @returns {Promise<void>}
 */
export const retryTokenRevocation = async (db, adminSecret, provider) => {
  const job = await getJobRow(db, TOKEN_REVOCATION_JOB);

  if (!job || job.due_at > Date.now()) {
    return;
  }

  const { attempts } = job;
  /** @type {number} */
  let pending;

  try {
    const state =
      getAdminSecretStatus(adminSecret) === 'ok'
        ? await getDataKeys(db, /** @type {string} */ (adminSecret))
        : null;

    // Without the data key, e.g. while the admin secret is being replaced, the tokens can’t be
    // decrypted to revoke them; they wait for it rather than being given up on
    pending =
      state?.status === 'ok'
        ? await revokePendingTokens(db, state.keys, provider)
        : await countPendingRevocations(db);
  } catch {
    // Tried again in a while; the other jobs run meanwhile
    await putJobRow(db, {
      name: TOKEN_REVOCATION_JOB,
      due_at: Date.now() + MAX_TOKEN_REVOCATION_DELAY,
      attempts: attempts + 1,
    });

    return;
  }

  if (!pending) {
    await deleteJobRow(db, TOKEN_REVOCATION_JOB);

    return;
  }

  await putJobRow(db, {
    name: TOKEN_REVOCATION_JOB,
    due_at: Date.now() + Math.min(2 ** (attempts + 1) * 60 * 1000, MAX_TOKEN_REVOCATION_DELAY),
    attempts: attempts + 1,
  });
};

/**
 * Revoke a user’s or a session’s Git tokens on behalf of a request, and schedule a retry for
 * any that couldn’t be revoked right away.
 * @param {import('hono').Context<import('../types.js').AppEnv>} c Hono context.
 * @param {import('../types.js').Platform} platform Platform services.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {Parameters<typeof revokeGitTokens>[3]} target Whose tokens to revoke; see
 * {@link revokeGitTokens}.
 * @returns {Promise<void>}
 */
export const revokeGitTokensForRequest = async (c, platform, keys, target) => {
  if ((await revokeGitTokens(c.get('db'), keys, c.get('gitProvider'), target)) > 0) {
    const at = await scheduleTokenRevocation(c.get('db'));

    if (at !== null) {
      await platform.scheduler.wakeAt(c.env, at);
    }
  }
};
