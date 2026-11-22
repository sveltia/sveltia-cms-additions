import { APIError } from 'better-auth/api';

import { getClientKey } from '../admin-secret.js';
import { logAudit } from '../audit.js';
import { createSessionToken, redeemCode } from '../auth/flows.js';
import { getAuth, requireDataKeys } from '../auth/index.js';
import { endUserAccess, loadSession, requireSession } from '../auth/session.js';
import { findUserById, toPublicUser, validateName, validatePrehash } from '../auth/users.js';
import { getCommitAuthor } from '../commit-author.js';
import { getDataKeys } from '../crypto/data-key.js';
import { getGitToken, revokeGitTokensForRequest } from '../git-tokens.js';
import { readJson } from '../http/body.js';
import { HttpError } from '../http/errors.js';
import { refreshUserToken } from '../provider-accounts.js';
import { consumeRateLimits } from '../rate-limit.js';
import { hasPasswordAccount } from '../store/users.js';

import { completeProviderLink, recheckRuleMember } from './provider-auth.js';

/**
 * @import { Hono } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * Rate limits on sign-in: every attempt per client, and failed attempts per username, to slow down
 * guessing one account’s password from many addresses without locking out its owner after a few
 * successful sign-ins.
 */
const SIGN_IN_LIMITS = { client: 30, username: 10, windowSeconds: 600 };

/**
 * Rate limit on wrong current passwords when changing one, so a stolen session can’t be used to
 * guess the password, e.g. to try it on other services.
 */
const PASSWORD_CHANGE_LIMIT = { limit: 10, windowSeconds: 600 };

/**
 * Create the function that refreshes a user’s user-to-server token, one call at a time.
 * @param {import('hono').Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform services.
 * @param {string} userId User ID.
 * @returns {() => Promise<{ token: string, expires_at: string } | null>} Function.
 */
const createUserTokenRefresher =
  (c, platform, userId) =>
  /**
   * Refresh the token.
   * @returns {Promise<{ token: string, expires_at: string } | null>} Token.
   */
  () =>
    // Shared by concurrent requests: a refresh token can only be spent once, and the second
    // request gets the token the first one got
    platform.runOnce(c.env, `github_token_refresh:${userId}`, async () => {
      const db = c.get('db');
      const state = await getDataKeys(db, /** @type {string} */ (c.env.ADMIN_SECRET));

      return state.status === 'ok'
        ? refreshUserToken(db, state.keys, c.get('gitProvider'), userId)
        : null;
    });

/**
 * Add how the CMS should author the user’s commits to a GitHub token.
 * @param {import('hono').Context<AppEnv>} c Hono context.
 * @param {ReturnType<typeof toPublicUser>} user User.
 * @param {Record<string, any>} git GitHub token.
 * @returns {Promise<Record<string, any>>} GitHub token, with the commit author for an installation
 * token.
 */
const withCommitAuthor = async (c, user, git) =>
  // Someone with their own GitHub token is the author of their commits anyway
  git.kind === 'installation'
    ? {
        ...git,
        commit_author: await getCommitAuthor(c.get('db'), user, new URL(c.req.url).hostname),
      }
    : git;

/**
 * Register the sign-in, sign-out, session and password endpoints.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerAuthRoutes = (app, platform) => {
  app.post('/v1/auth/sign-in', async (c) => {
    const body = await readJson(c);
    const prehash = validatePrehash(body.prehash);

    // Don’t tell whether a malformed username exists; treat it like a wrong password
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const { windowSeconds } = SIGN_IN_LIMITS;
    const clientKey = getClientKey(c.req.header('cf-connecting-ip'));
    const usernameKey = `sign_in:username:${username}`;

    const { refund } = await consumeRateLimits(platform, c.env, [
      { key: `sign_in:client:${clientKey}`, limit: SIGN_IN_LIMITS.client, windowSeconds },
      { key: usernameKey, limit: SIGN_IN_LIMITS.username, windowSeconds },
    ]);

    const auth = await getAuth(c, platform);
    /** @type {{ headers: Headers, response: { user: any } }} */
    let result;

    try {
      result = /** @type {any} */ (
        await auth.api.signInUsername({
          body: { username, password: prehash },
          returnHeaders: true,
        })
      );
    } catch (error) {
      if (error instanceof APIError) {
        if (error.status === 'FORBIDDEN') {
          throw new HttpError(403, 'user_disabled', 'This account is disabled.');
        }

        throw new HttpError(401, 'invalid_credentials', 'The username or password is wrong.');
      }

      throw error;
    }

    // Only failed attempts count against the username
    await refund([usernameKey]);

    const { headers, response } = result;
    const user = await (await auth.$context).internalAdapter.findUserById(response.user.id);

    await logAudit(c.get('db'), { action: 'auth.sign_in', actorId: response.user.id });

    return c.json({
      session_token: headers.get('set-auth-token'),
      user: toPublicUser(/** @type {any} */ (user)),
    });
  });

  app.post(
    '/v1/auth/sign-out',
    requireSession(platform, { allowPasswordChange: true }),
    async (c) => {
      const auth = await getAuth(c, platform);
      const session = c.get('session');

      await (await auth.$context).internalAdapter.deleteSession(session.token);
      await revokeGitTokensForRequest(c, platform, await requireDataKeys(c), {
        sessionId: session.id,
      });

      return c.json({ signed_out: true });
    },
  );

  // The current user, with a GitHub token for the site’s repository. The CMS calls this again to
  // get a new token before the current one expires.
  app.get(
    '/v1/auth/session',
    requireSession(platform, { allowPasswordChange: true }),
    async (c) => {
      const user = toPublicUser(c.get('user'));
      // Someone who only signs in with GitHub has no password to change
      const hasPassword = await hasPasswordAccount(c.get('db'), user.id);

      if (!user.must_change_password) {
        await recheckRuleMember(c, platform, user.id);
      }

      const git = user.must_change_password
        ? null
        : await getGitToken(c.get('db'), await requireDataKeys(c), c.get('gitProvider'), {
            userId: user.id,
            sessionId: c.get('session').id,
            role: user.role,
            refreshUserToken: createUserTokenRefresher(c, platform, user.id),
          });

      return c.json({
        user: { ...user, has_password: hasPassword },
        git: git && (await withCommitAuthor(c, user, git)),
      });
    },
  );

  // OAuth-style token endpoint. The refresh token grant exchanges the session token for a GitHub
  // token, so the CMS’s existing refresh-on-401 code gets a new one when the current one expires or
  // is revoked; the session token stays the same. The authorization code grant ends a sign-in
  // through a provider, with PKCE, and starts a session. Either way the GitHub token is the access
  // token and the session token the refresh token, which is how the CMS stores them
  app.post('/v1/auth/token', async (c) => {
    const body = await readJson(c);
    const db = c.get('db');
    /** @type {{ session: any, user: any }} */
    let current;
    /** @type {string} */
    let sessionToken;

    if (body.grant_type === 'refresh_token' && typeof body.refresh_token === 'string') {
      sessionToken = body.refresh_token;
      current = await loadSession(c, platform, `Bearer ${sessionToken}`);
    } else if (body.grant_type === 'authorization_code') {
      const { userId, link } = await redeemCode(c.get('db'), body, () => requireDataKeys(c));

      // A GitHub account is only linked now, by the CMS that asked for it
      if (link) {
        await completeProviderLink(c, platform, await requireDataKeys(c), userId, link);
      }

      // The user may have been disabled since the code was issued
      const user = await findUserById(db, userId);

      if (!user || user.banned) {
        throw new HttpError(403, 'user_disabled', 'This account is disabled.');
      }

      const created = await createSessionToken(await getAuth(c, platform), userId);

      sessionToken = created.token;

      try {
        current = await loadSession(c, platform, `Bearer ${sessionToken}`);
      } catch (error) {
        // Not a session anyone can use, e.g. as an admin has just reset the password
        await (
          await (
            await getAuth(c, platform)
          ).$context
        ).internalAdapter.deleteSession(created.session.token);

        throw error;
      }
    } else {
      throw new HttpError(
        400,
        'unsupported_grant_type',
        'Only the refresh token and authorization code grants work here.',
      );
    }

    const publicUser = toPublicUser(current.user);

    await recheckRuleMember(c, platform, publicUser.id);

    const git = await getGitToken(db, await requireDataKeys(c), c.get('gitProvider'), {
      userId: publicUser.id,
      sessionId: current.session.id,
      role: publicUser.role,
      refreshUserToken: createUserTokenRefresher(c, platform, publicUser.id),
    });

    if (!git) {
      throw new HttpError(409, 'github_app_not_set_up', 'The GitHub App isn’t set up yet.');
    }

    return c.json({
      access_token: git.token,
      refresh_token: sessionToken,
      token_type: 'bearer',
      expires_in: Math.floor((new Date(git.expires_at).getTime() - Date.now()) / 1000),
      user: publicUser,
      git: await withCommitAuthor(c, publicUser, git),
    });
  });

  // Change your own password. All sessions end, and a new one is returned for the current client
  app.post(
    '/v1/auth/password',
    requireSession(platform, { allowPasswordChange: true }),
    async (c) => {
      const body = await readJson(c);
      const currentPrehash = validatePrehash(body.current_prehash);
      const newPrehash = validatePrehash(body.new_prehash);
      const user = c.get('user');

      if (currentPrehash === newPrehash) {
        throw new HttpError(400, 'same_password', 'Choose a password you haven’t used just now.');
      }

      const { refund } = await consumeRateLimits(platform, c.env, [
        { key: `password_change:user:${user.id}`, ...PASSWORD_CHANGE_LIMIT },
      ]);

      const auth = await getAuth(c, platform);
      /** @type {{ headers: Headers }} */
      let result;

      try {
        result = /** @type {any} */ (
          await auth.api.changePassword({
            body: {
              currentPassword: currentPrehash,
              newPassword: newPrehash,
              revokeOtherSessions: true,
            },
            headers: new Headers({
              authorization: /** @type {string} */ (c.req.header('authorization')),
            }),
            returnHeaders: true,
          })
        );
      } catch (error) {
        if (error instanceof APIError) {
          // Someone who only signs in with the Git provider has no password, rather than a wrong
          // one
          if (!(await hasPasswordAccount(c.get('db'), user.id))) {
            await refund();

            throw new HttpError(409, 'no_password', 'This account has no password to change.');
          }

          throw new HttpError(400, 'wrong_password', 'The current password is wrong.');
        }

        throw error;
      }

      // Only wrong passwords count
      await refund();
      await (
        await auth.$context
      ).internalAdapter.updateUser(user.id, { mustChangePassword: false });
      await revokeGitTokensForRequest(c, platform, await requireDataKeys(c), { userId: user.id });
      // The other sessions have ended; so do the links and tabs they may have started
      await endUserAccess(c, platform, user.id, { sessions: false });
      await logAudit(c.get('db'), { action: 'auth.password_change', actorId: user.id });

      return c.json({ session_token: result.headers.get('set-auth-token') });
    },
  );

  // Change your own name, which is how you appear in the CMS and on your commits; a temporary
  // password has to be replaced first. The email is left to admins: it’s the commit author email,
  // which GitHub links to whoever owns the address, so anyone could pass their commits off as
  // someone else’s
  app.patch('/v1/auth/profile', requireSession(platform), async (c) => {
    const body = await readJson(c);
    const user = c.get('user');

    if ('email' in body) {
      throw new HttpError(403, 'forbidden', 'Only admins can change the email address.');
    }

    if (!('name' in body)) {
      throw new HttpError(400, 'invalid_body', 'Nothing to change.');
    }

    const { internalAdapter } = await (await getAuth(c, platform)).$context;
    const updated = await internalAdapter.updateUser(user.id, { name: validateName(body.name) });

    await logAudit(c.get('db'), {
      action: 'auth.profile_update',
      actorId: user.id,
      target: user.id,
      meta: { fields: ['name'] },
    });

    return c.json({ user: toPublicUser(/** @type {any} */ ({ ...user, ...updated })) });
  });
};
