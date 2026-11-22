import { timingSafeEqualStrings } from './crypto/compare.js';
import { HttpError } from './http/errors.js';
import { consumeRateLimits } from './rate-limit.js';

/**
 * @import { Context } from 'hono';
 * @import { AppEnv, Platform } from '../types.js';
 */

/**
 * Minimum length of `ADMIN_SECRET`. `openssl rand -base64 32` produces 44 characters.
 */
export const ADMIN_SECRET_MIN_LENGTH = 32;

/**
 * Rate limits on failed admin secret attempts: per client, and across all clients to slow down a
 * distributed attack. Successful requests don’t count, as setting up takes several of them.
 */
const RATE_LIMITS = [
  { scope: 'client', limit: 10, windowSeconds: 600 },
  { scope: 'all', limit: 50, windowSeconds: 600 },
];

/**
 * Check whether `ADMIN_SECRET` is configured properly.
 * @param {string | undefined} secret Configured secret.
 * @returns {'ok' | 'missing' | 'too_short'} Status.
 */
export const getAdminSecretStatus = (secret) => {
  if (!secret) {
    return 'missing';
  }

  return secret.length < ADMIN_SECRET_MIN_LENGTH ? 'too_short' : 'ok';
};

/**
 * Get a rate limit key for the client. IPv6 addresses are grouped by their `/64` prefix, which a
 * single client usually controls in full.
 * @param {string | undefined} ip Client IP address.
 * @returns {string} Key.
 */
export const getClientKey = (ip) => {
  if (!ip) {
    return 'unknown';
  }

  if (!ip.includes(':')) {
    return ip;
  }

  // Expand `::` so the first four groups are always the prefix
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = ip.includes('::') && tail ? tail.split(':') : [];
  const missing = ip.includes('::') ? 8 - headGroups.length - tailGroups.length : 0;
  const groups = [...headGroups, ...Array(Math.max(missing, 0)).fill('0'), ...tailGroups];

  return `${groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0'))
    .join(':')}::/64`;
};

/**
 * Verify the admin secret sent with a request as `Authorization: Bearer <secret>`. Failed attempts
 * are rate-limited, and once the limit is reached, even the right secret is refused until it resets.
 * @param {Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform services.
 * @returns {Promise<void>}
 * @throws {HttpError} If the secret isn’t configured, is missing or wrong, or the client made too
 * many attempts.
 */
export const verifyAdminSecret = async (c, platform) => {
  const configured = c.env.ADMIN_SECRET;
  const status = getAdminSecretStatus(configured);

  if (status !== 'ok') {
    throw new HttpError(
      503,
      `admin_secret_${status}`,
      `ADMIN_SECRET must be set to a random value of at least ${ADMIN_SECRET_MIN_LENGTH} ` +
        'characters in the Worker settings.',
    );
  }

  const clientKey = getClientKey(c.req.header('cf-connecting-ip'));

  const { refund } = await consumeRateLimits(
    platform,
    c.env,
    RATE_LIMITS.map(({ scope, limit, windowSeconds }) => ({
      key: `admin_secret:${scope === 'all' ? '*' : clientKey}`,
      limit,
      windowSeconds,
    })),
  );

  const [scheme, provided = ''] = (c.req.header('authorization') ?? '').split(' ');

  if (scheme !== 'Bearer' || !(await timingSafeEqualStrings(provided, configured ?? ''))) {
    throw new HttpError(401, 'wrong_admin_secret', 'The admin secret is wrong.');
  }

  // Only failed attempts count, as setting up takes several requests
  await refund();
};
