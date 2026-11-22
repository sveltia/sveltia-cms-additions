import { admin } from 'better-auth/plugins/admin';
import { bearer } from 'better-auth/plugins/bearer';
import { username } from 'better-auth/plugins/username';

import { hashPrehash, PREHASH_LENGTH, verifyPrehash } from './password.js';

/**
 * @import { BetterAuthOptions } from 'better-auth';
 */

/**
 * Roles, from the most to the least privileged.
 */
export const ROLES = /** @type {const} */ (['admin', 'editor', 'viewer']);

/**
 * How long a session lasts without being used. Using it extends it, at most once an hour.
 */
export const SESSION_IDLE_TIMEOUT = 24 * 60 * 60;

/**
 * How long a session lasts in any case, however often it’s used.
 */
export const SESSION_MAX_AGE = 7 * 24 * 60 * 60;

/**
 * A username: lower-case letters, digits, dots, hyphens and underscores, 3 to 30 characters.
 */
export const USERNAME_REGEX = /^[a-z\d._-]{3,30}$/;

/**
 * Create the Better Auth options. They are kept free of platform code so the database schema can
 * also be generated outside the Workers runtime; see `scripts/print-auth-schema.js`.
 *
 * Better Auth’s own HTTP handler is never exposed: the `/v1` routes call `auth.api` on the server,
 * so endpoints we don’t use can’t be reached, and plugins we don’t need aren’t installed.
 * @param {object} args Arguments.
 * @param {any} args.database Database, e.g. a Kysely dialect.
 * @param {string} args.secret Session-signing secret, derived from the data key.
 * @param {string} args.baseURL Origin of the service.
 * @returns {BetterAuthOptions} Options.
 */
export const getAuthOptions = ({ database, secret, baseURL }) => ({
  database,
  secret,
  baseURL,
  basePath: '/auth',
  telemetry: { enabled: false },
  logger: { level: 'error' },
  // Requests are rate-limited by our own routes with the Durable Object, since Better Auth’s
  // in-memory counters don’t work across Workers isolates
  rateLimit: { enabled: false },
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    // The “password” is always a prehash of a fixed length
    minPasswordLength: PREHASH_LENGTH,
    maxPasswordLength: PREHASH_LENGTH,
    password: { hash: hashPrehash, verify: verifyPrehash },
  },
  session: {
    expiresIn: SESSION_IDLE_TIMEOUT,
    updateAge: 60 * 60,
  },
  account: {
    accountLinking: { enabled: false },
  },
  user: {
    additionalFields: {
      mustChangePassword: { type: 'boolean', required: false, defaultValue: false, input: false },
    },
  },
  plugins: [
    admin({ defaultRole: 'viewer', adminRoles: ['admin'] }),
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
      /**
       * Check a username after Better Auth lower-cases it.
       * @param {string} value Username.
       * @returns {boolean} Whether it’s valid.
       */
      usernameValidator: (value) => USERNAME_REGEX.test(value),
    }),
    bearer({ requireSignature: true }),
  ],
});
