import { betterAuth } from 'better-auth';

import { getAdminSecretStatus } from '../admin-secret.js';
import { getDataKeys } from '../crypto/data-key.js';
import { HttpError } from '../http/errors.js';

import { getAuthOptions } from './options.js';

/**
 * @import { Context } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * Better Auth instance with our options.
 * @typedef {ReturnType<typeof betterAuth<ReturnType<typeof getAuthOptions>>>} Auth
 */

/**
 * Cached instances, by database: every tenant has its own, and several tenants can share an
 * isolate. Creating one is cheap but not free, and it only changes when the signing secret or the
 * base URL does.
 * @type {WeakMap<object, { cacheKey: string, auth: Auth }>}
 */
const caches = new WeakMap();

/**
 * Get the keys derived from the data key, failing the request if they’re unavailable.
 * @param {Context<AppEnv>} c Hono context.
 * @returns {Promise<import('../../types.js').DataKeys>} Keys.
 * @throws {HttpError} If `ADMIN_SECRET` isn’t configured, or the data key is locked because the
 * secret was replaced.
 */
export const requireDataKeys = async (c) => {
  const secret = c.env.ADMIN_SECRET;

  if (getAdminSecretStatus(secret) !== 'ok') {
    throw new HttpError(503, 'not_configured', 'ADMIN_SECRET is not configured properly.');
  }

  const state = await getDataKeys(c.get('db'), secret);

  if (state.status !== 'ok') {
    throw new HttpError(
      503,
      'data_key_locked',
      'ADMIN_SECRET was changed. An admin must re-wrap or re-key the data key.',
    );
  }

  return state.keys;
};

/**
 * Get the Better Auth instance for a request.
 * @param {Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform services.
 * @returns {Promise<Auth>} Better Auth instance.
 * @throws {HttpError} If the data key is unavailable.
 */
export const getAuth = async (c, platform) => {
  const { signingSecret: secret } = await requireDataKeys(c);
  const database = c.get('authDatabase');
  const baseURL = platform.getBaseURL(c.req.raw);
  const cacheKey = `${secret} ${baseURL}`;
  let cache = caches.get(database);

  if (cache?.cacheKey !== cacheKey) {
    cache = { cacheKey, auth: betterAuth(getAuthOptions({ database, secret, baseURL })) };
    caches.set(database, cache);
  }

  return cache.auth;
};
