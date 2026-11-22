/**
 * Fixed-window rate limits, counted in a Durable Object instance’s SQL storage. A check and its
 * increment are one statement, so they’re atomic.
 * @import { RateLimitResult, SqlStorage } from '../../types.js';
 */

/**
 * Create the table of the counters, if needed.
 * @param {SqlStorage} sql Storage.
 */
export const createRateLimitTable = (sql) => {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS rate_limit ' +
      '(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL)',
  );
};

/**
 * Count a request against a rate limit.
 * @param {SqlStorage} sql Storage.
 * @param {object} args Arguments.
 * @param {string} args.key Counter key.
 * @param {number} args.limit Requests allowed per window.
 * @param {number} args.windowSeconds Window length.
 * @param {number} [args.now] Current time.
 * @returns {RateLimitResult} Result.
 */
export const consumeRateLimit = (sql, { key, limit, windowSeconds, now = Date.now() }) => {
  sql.exec('DELETE FROM rate_limit WHERE reset_at <= ?', now);

  // Counted in one statement, which leaves a counter at the limit as it is
  const [counted] = sql
    .exec(
      'INSERT INTO rate_limit (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT (key) ' +
        'DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count',
      key,
      now + windowSeconds * 1000,
      limit,
    )
    .toArray();

  if (counted) {
    return { allowed: true, retryAfter: 0 };
  }

  const { reset_at: resetAt } = sql
    .exec('SELECT reset_at FROM rate_limit WHERE key = ?', key)
    .one();

  return { allowed: false, retryAfter: Math.ceil((Number(resetAt) - now) / 1000) };
};

/**
 * Take back a request counted with {@link consumeRateLimit}, e.g. a successful attempt where only
 * failures should count.
 * @param {SqlStorage} sql Storage.
 * @param {string} key Counter key.
 */
export const refundRateLimit = (sql, key) => {
  sql.exec('UPDATE rate_limit SET count = count - 1 WHERE key = ? AND count > 0', key);
};
