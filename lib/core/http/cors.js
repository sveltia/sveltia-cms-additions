import { getAllowedDomains, isOriginAllowed } from '../allowed-domains.js';

import { errorResponse } from './errors.js';

/**
 * @import { MiddlewareHandler } from 'hono';
 * @import { AppEnv } from '../../types.js';
 */

/**
 * Request headers the CMS may send.
 */
const ALLOWED_HEADERS = 'Authorization, Content-Type';

/**
 * Methods the API uses.
 */
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE';

/**
 * Check whether a path may be called from any origin. These are `/version`, which the CMS reads
 * before anything is configured, and the endpoints authenticated with `ADMIN_SECRET`: the setup
 * wizard’s, which set up the allowed domains in the first place, and the operator API’s, which
 * manage the tenants. The secret is the credential, and there is no cookie or other ambient
 * credential a foreign page could ride on.
 * @param {string} path Request path.
 * @returns {boolean} Result.
 */
export const isPublicPath = (path) =>
  path === '/version' ||
  path.startsWith('/v1/setup/') ||
  path === '/v1/tenants' ||
  path.startsWith('/v1/tenants/');

/**
 * CORS middleware. A cross-origin request is answered with `Access-Control-Allow-Origin` echoing
 * its origin only when the origin is allowed, and a request from any other origin is refused
 * outright, so a “simple” request that skips the preflight can’t change anything either. Requests
 * without an `Origin` header, e.g. from `curl`, pass through: they carry no browser credentials,
 * and the endpoints authenticate them as usual.
 * @returns {MiddlewareHandler<AppEnv>} Middleware.
 */
export const cors = () => async (c, next) => {
  const origin = c.req.header('origin');
  const isPreflight = c.req.method === 'OPTIONS';

  if (!origin) {
    if (isPreflight) {
      return new Response(null, { status: 204 });
    }

    await next();

    return undefined;
  }

  const allowed =
    isPublicPath(c.req.path) || isOriginAllowed(origin, await getAllowedDomains(c.get('db')));

  if (!allowed) {
    return errorResponse(403, 'origin_not_allowed', `${origin} is not an allowed domain.`, {
      Vary: 'Origin',
    });
  }

  /** @type {Record<string, string>} */
  const headers = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };

  if (isPreflight) {
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        'Access-Control-Allow-Methods': ALLOWED_METHODS,
        'Access-Control-Allow-Headers': ALLOWED_HEADERS,
        'Access-Control-Max-Age': '600',
      },
    });
  }

  await next();

  // A WebSocket isn’t subject to CORS, and its response can’t be changed
  if (c.res.status === 101) {
    return undefined;
  }

  Object.entries(headers).forEach(([name, value]) => {
    c.res.headers.set(name, value);
  });

  return undefined;
};
