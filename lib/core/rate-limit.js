import { HttpError } from './http/errors.js';

/**
 * @import { Platform } from '../types.js';
 */

/**
 * A fixed-window rate limit.
 * @typedef {object} RateLimit
 * @property {string} key Counter key.
 * @property {number} limit Requests allowed per window.
 * @property {number} windowSeconds Window length.
 */

/**
 * Count a request against several rate limits at once. Each attempt is counted before it’s
 * checked, atomically, so parallel requests can’t all slip through before the first failure is
 * recorded. A limit that should only count failures is refunded once the attempt succeeds.
 * @param {Platform} platform Platform services.
 * @param {any} env Platform bindings.
 * @param {RateLimit[]} limits Limits.
 * @returns {Promise<{ refund: (keys?: string[]) => Promise<void> }>} Function that takes the
 * request back from the given limits, or all of them.
 * @throws {HttpError} If any limit is reached. The request isn’t counted against the others then.
 */
export const consumeRateLimits = async (platform, env, limits) => {
  const results = await Promise.all(
    limits.map(({ key, limit, windowSeconds }) =>
      platform.rateLimits.consume(env, key, { limit, windowSeconds }),
    ),
  );

  const counted = limits.filter((_, index) => results[index].allowed).map(({ key }) => key);

  /**
   * Take the request back from the given limits.
   * @param {string[]} [keys] Counter keys. Default: every limit the request was counted against.
   * @returns {Promise<void>}
   */
  const refund = async (keys = counted) => {
    await Promise.all(
      keys
        .filter((key) => counted.includes(key))
        .map((key) => platform.rateLimits.refund(env, key)),
    );
  };

  const blocked = results.find(({ allowed }) => !allowed);

  if (blocked) {
    await refund();

    throw new HttpError(429, 'too_many_attempts', 'Too many attempts. Try again later.', {
      'Retry-After': String(blocked.retryAfter),
    });
  }

  return { refund };
};
