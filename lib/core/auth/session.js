import { HttpError } from '../http/errors.js';
import { deleteUserTickets } from '../store/locks.js';
import { deletePresenceRows } from '../store/presence.js';

import { forgetPendingFlows } from './flows.js';
import { SESSION_MAX_AGE } from './options.js';

import { getAuth } from './index.js';

/**
 * @import { Context, MiddlewareHandler } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * Load and check the session for an `Authorization: Bearer <token>` header value.
 * @param {import('hono').Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform services.
 * @param {string | undefined} authorization `Authorization` header value.
 * @param {object} [options] Options.
 * @param {'admin'} [options.role] Role the user must have.
 * @param {boolean} [options.allowPasswordChange] Whether a user who must change their password is
 * accepted.
 * @returns {Promise<{ session: any, user: any }>} Session and user.
 * @throws {HttpError} If the session is missing, invalid or expired, or the user may not proceed.
 */
export const loadSession = async (
  c,
  platform,
  authorization,
  { role, allowPasswordChange = false } = {},
) => {
  if (!authorization?.startsWith('Bearer ')) {
    throw new HttpError(401, 'unauthenticated', 'Sign in first.');
  }

  const auth = await getAuth(c, platform);
  const result = await auth.api.getSession({ headers: new Headers({ authorization }) });

  if (!result) {
    throw new HttpError(401, 'unauthenticated', 'The session has expired. Sign in again.');
  }

  const { session, user } = /** @type {{ session: any, user: any }} */ (result);

  // Better Auth extends a session as long as it’s used; end it after a fixed time regardless
  if (Date.now() - new Date(session.createdAt).getTime() > SESSION_MAX_AGE * 1000) {
    await (await auth.$context).internalAdapter.deleteSession(session.token);

    throw new HttpError(401, 'unauthenticated', 'The session has expired. Sign in again.');
  }

  if (user.banned) {
    throw new HttpError(403, 'user_disabled', 'This account is disabled.');
  }

  if (user.mustChangePassword && !allowPasswordChange) {
    throw new HttpError(403, 'password_change_required', 'Change your password first.');
  }

  if (role && user.role !== role) {
    throw new HttpError(403, 'forbidden', 'Only admins can do this.');
  }

  return { session, user };
};

/**
 * Create a middleware that requires a valid session, sent as `Authorization: Bearer <token>`, and
 * makes the user and session available as `c.get('user')` and `c.get('session')`.
 * @param {Platform} platform Platform services.
 * @param {object} [options] Options for {@link loadSession}.
 * @param {'admin'} [options.role] Role the user must have.
 * @param {boolean} [options.allowPasswordChange] Whether a user who must change their password may
 * use the endpoint. Only sign-out, the session and the password change itself allow it.
 * @returns {MiddlewareHandler<AppEnv>} Middleware.
 */
export const requireSession = (platform, options) => async (c, next) => {
  const { session, user } = await loadSession(c, platform, c.req.header('authorization'), options);

  c.set('session', session);
  c.set('user', user);

  await next();
};

/**
 * Make sure the signed-in user can change content, which an editor or an admin can, but a viewer
 * can’t. Their session has been checked already, by {@link requireSession}.
 * @param {Context<AppEnv>} c Hono context.
 * @throws {HttpError} If they’re a viewer.
 */
export const requireEditor = (c) => {
  if (c.get('user').role === 'viewer') {
    throw new HttpError(403, 'forbidden', 'Viewers can’t change content.');
  }
};

/**
 * End a user’s access everywhere: their sessions, but for the one to keep, e.g. the current one
 * after a password change, their sign-ins in progress, and their CMS tabs’ connections, which carry
 * the role they were opened with.
 * @param {Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform services.
 * @param {string} userId User ID.
 * @param {object} [options] Options.
 * @param {boolean} [options.sessions] Whether to end their sessions. A role change keeps them, and a
 * password change has ended the others already.
 * @returns {Promise<void>}
 */
export const endUserAccess = async (c, platform, userId, { sessions = true } = {}) => {
  if (sessions) {
    await (await (await getAuth(c, platform)).$context).internalAdapter.deleteUserSessions(userId);
  }

  await forgetPendingFlows(c.get('db'), userId);
  // A ticket carries the role it was issued with, so one not used yet mustn’t open a connection
  await deleteUserTickets(c.get('db'), userId);
  // Their tabs’ heartbeats, where there are no live updates, so their locks get the grace period
  await deletePresenceRows(c.get('db'), { userId });
  await platform.realtime?.disconnectUser(c.env, userId);
};
