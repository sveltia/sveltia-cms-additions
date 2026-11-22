import { HttpError } from '../http/errors.js';
import {
  countActiveAdminRows,
  deleteUserUnlessLastAdmin,
  findUserRow,
  updateUserAccessUnlessLastAdmin,
} from '../store/users.js';

import { ROLES, USERNAME_REGEX } from './options.js';
import { PREHASH_REGEX } from './password.js';

/**
 * @import { Database } from '../../types.js';
 * @import { Auth } from './index.js';
 */

/**
 * A user as stored in the `user` table.
 * @typedef {object} UserRow
 * @property {string} id ID.
 * @property {string} username Username.
 * @property {string} name Display name.
 * @property {string} email Email, or a placeholder.
 * @property {string | null} role Role.
 * @property {number | boolean | null} banned Whether the user is disabled.
 * @property {number | boolean | null} mustChangePassword Whether the user must change their
 * password before doing anything else.
 * @property {string | Date} createdAt Creation date.
 */

/**
 * A user as returned by the API.
 * @typedef {object} PublicUser
 * @property {string} id ID.
 * @property {string} username Username.
 * @property {string} name Display name.
 * @property {string | null} email Email, if one was set.
 * @property {'admin' | 'editor' | 'viewer'} role Role.
 * @property {boolean} disabled Whether the user is disabled.
 * @property {boolean} must_change_password Whether the user must change their password.
 * @property {string} created_at Creation date, as ISO 8601.
 */

/**
 * Domain of the placeholder email addresses given to users without an email. Better Auth requires
 * an email, and the reserved `.invalid` top-level domain can never receive mail.
 */
const PLACEHOLDER_EMAIL_DOMAIN = 'users.invalid';

/**
 * Get the placeholder email for a user without one.
 * @param {string} username Username.
 * @returns {string} Email.
 */
export const getPlaceholderEmail = (username) => `${username}@${PLACEHOLDER_EMAIL_DOMAIN}`;

/**
 * Convert a stored user for the API.
 * @param {UserRow} user Stored user.
 * @returns {PublicUser} User.
 */
export const toPublicUser = (user) => ({
  id: user.id,
  username: user.username,
  name: user.name,
  email: user.email.endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`) ? null : user.email,
  role: ROLES.includes(/** @type {any} */ (user.role)) ? /** @type {any} */ (user.role) : 'viewer',
  disabled: !!user.banned,
  must_change_password: !!user.mustChangePassword,
  created_at: new Date(user.createdAt).toISOString(),
});

/**
 * Validate a username.
 * @param {unknown} value Value to check.
 * @returns {string} Username.
 * @throws {HttpError} If it’s invalid.
 */
export const validateUsername = (value) => {
  if (typeof value !== 'string' || !USERNAME_REGEX.test(value)) {
    throw new HttpError(
      400,
      'invalid_username',
      'A username has 3 to 30 lower-case letters, digits, dots, hyphens or underscores.',
    );
  }

  return value;
};

/**
 * Validate a prehash.
 * @param {unknown} value Value to check.
 * @returns {string} Prehash.
 * @throws {HttpError} If it’s invalid.
 */
export const validatePrehash = (value) => {
  if (typeof value !== 'string' || !PREHASH_REGEX.test(value)) {
    throw new HttpError(400, 'invalid_prehash', 'The password must be sent as a prehash.');
  }

  return value;
};

/**
 * Validate a role.
 * @param {unknown} value Value to check.
 * @returns {'admin' | 'editor' | 'viewer'} Role.
 * @throws {HttpError} If it’s invalid.
 */
export const validateRole = (value) => {
  if (!ROLES.includes(/** @type {any} */ (value))) {
    throw new HttpError(400, 'invalid_role', `The role must be one of ${ROLES.join(', ')}.`);
  }

  return /** @type {'admin' | 'editor' | 'viewer'} */ (value);
};

/**
 * Control characters, including line breaks and tabs, and the Unicode line and paragraph
 * separators, which have no place in a name. A line break in a name would add a line of its own
 * to a commit message that credits the user, e.g. a forged `Co-authored-by` trailer.
 */
const NAME_CONTROL_REGEX = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Validate a display name.
 * @param {unknown} value Value to check.
 * @returns {string} Name.
 * @throws {HttpError} If it’s invalid.
 */
export const validateName = (value) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 100 ||
    NAME_CONTROL_REGEX.test(value)
  ) {
    throw new HttpError(
      400,
      'invalid_name',
      'The name must have 1 to 100 characters, without line breaks.',
    );
  }

  return value.trim();
};

/**
 * Validate an email address, or `null` for none.
 * @param {unknown} value Value to check.
 * @returns {string | null} Lower-cased email, or `null`.
 * @throws {HttpError} If it’s invalid.
 */
export const validateEmail = (value) => {
  if (value === null || value === '') {
    return null;
  }

  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ||
    value.toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)
  ) {
    throw new HttpError(400, 'invalid_email', 'The email address is not valid.');
  }

  // Normalized like Better Auth compares them, so two ways of writing the same address are one
  return value.normalize('NFC').toLowerCase();
};

/**
 * Work out the email to store for a user from a requested change, checking it isn’t another user’s.
 * No email stores the user’s placeholder address, as Better Auth requires one.
 * @param {{ findUserByEmail: (email: string) => Promise<{ user: { id: string } } | null> }}
 * internalAdapter Better Auth’s internal adapter.
 * @param {{ id: string, username: string }} target User being changed.
 * @param {unknown} value Requested email, or `null` or an empty string for none.
 * @returns {Promise<string>} Email to store.
 * @throws {HttpError} If the email is invalid, or another user has it.
 */
export const resolveEmailChange = async (internalAdapter, target, value) => {
  const email = validateEmail(value) ?? getPlaceholderEmail(target.username);
  const owner = await internalAdapter.findUserByEmail(email);

  if (owner && owner.user.id !== target.id) {
    throw new HttpError(409, 'email_taken', 'Another user has this email address.');
  }

  return email;
};

/**
 * Find a user by ID.
 * @param {Database} db Database.
 * @param {string} id User ID.
 * @returns {Promise<UserRow | null>} User.
 */
export const findUserById = (db, id) => findUserRow(db, { id });

/**
 * Find a user by username.
 * @param {Database} db Database.
 * @param {string} username Username.
 * @returns {Promise<UserRow | null>} User.
 */
export const findUserByUsername = (db, username) => findUserRow(db, { username });

/**
 * Find a user by ID, failing the request if there is none.
 * @param {Database} db Database.
 * @param {string} id User ID.
 * @returns {Promise<UserRow>} User.
 * @throws {HttpError} If the user doesn’t exist.
 */
export const requireUser = async (db, id) => {
  const user = await findUserById(db, id);

  if (!user) {
    throw new HttpError(404, 'user_not_found', 'There is no such user.');
  }

  return user;
};

/**
 * Count the admins who can sign in.
 * @param {Database} db Database.
 * @returns {Promise<number>} Number of enabled admins.
 */
export const countActiveAdmins = (db) => countActiveAdminRows(db);

/**
 * Make sure a change leaves at least one admin who can sign in. This only fails early, before
 * waiting for anything else: the change itself goes through {@link changeUserAccess}, or
 * {@link deleteUser}, which check again in the same statement.
 * @param {Database} db Database.
 * @param {UserRow} user User about to lose admin access.
 * @returns {Promise<void>}
 * @throws {HttpError} If the user is the last active admin.
 */
export const assertNotLastAdmin = async (db, user) => {
  if (user.role === 'admin' && !user.banned && (await countActiveAdmins(db)) <= 1) {
    throw new HttpError(409, 'last_admin', 'There must be at least one admin.');
  }
};

/**
 * Fail a change that left a user as they were: either they are the last admin, or they have been
 * deleted in the meantime.
 * @param {Database} db Database.
 * @param {string} id User ID.
 * @returns {Promise<never>} Never resolves.
 * @throws {HttpError} Always.
 */
const failUnchangedUser = async (db, id) => {
  await requireUser(db, id);

  throw new HttpError(409, 'last_admin', 'There must be at least one admin.');
};

/**
 * Change a user’s role or disable them, leaving at least one admin who can sign in.
 * @param {Database} db Database.
 * @param {string} id User ID.
 * @param {{ role?: string, banned?: boolean }} changes Changes.
 * @returns {Promise<void>}
 * @throws {HttpError} If the user is the last active admin.
 */
export const changeUserAccess = async (db, id, changes) => {
  if (!(await updateUserAccessUnlessLastAdmin(db, id, changes))) {
    await failUnchangedUser(db, id);
  }
};

/**
 * Delete a user, leaving at least one admin who can sign in.
 * @param {Database} db Database.
 * @param {string} id User ID.
 * @returns {Promise<void>}
 * @throws {HttpError} If the user is the last active admin.
 */
export const deleteUser = async (db, id) => {
  if (!(await deleteUserUnlessLastAdmin(db, id))) {
    await failUnchangedUser(db, id);
  }
};

/**
 * Create a user, with a password or, for someone who signs in with a provider, without one.
 * @param {Auth} auth Better Auth instance.
 * @param {object} args Arguments.
 * @param {string} args.username Username.
 * @param {string} args.name Display name.
 * @param {string | null} [args.email] Email.
 * @param {'admin' | 'editor' | 'viewer'} args.role Role.
 * @param {string} [args.prehash] Prehash of the password, if any.
 * @param {boolean} args.mustChangePassword Whether the user must change the password at the next
 * sign-in, which is the case for a password an admin made up.
 * @returns {Promise<UserRow>} Created user.
 * @throws {HttpError} If the username or email is taken.
 */
export const createUser = async (
  auth,
  { username, name, email = null, role, prehash, mustChangePassword },
) => {
  const ctx = await auth.$context;

  // Without an email, the placeholder address made of the username is only taken if the username
  // is, which creating the user reports as such
  if (email && (await ctx.internalAdapter.findUserByEmail(email))) {
    throw new HttpError(409, 'email_taken', 'Another user has this email address.');
  }

  /** @type {UserRow} */
  let user;

  try {
    user = /** @type {any} */ (
      await ctx.internalAdapter.createUser(
        {
          email: email ?? getPlaceholderEmail(username),
          emailVerified: false,
          name,
          username,
          displayUsername: username,
          role,
          mustChangePassword,
        },
        { method: 'admin' },
      )
    );
  } catch (error) {
    const message = String(/** @type {Error} */ (error)?.message);

    if (/UNIQUE|already/i.test(message)) {
      // Another request may have taken the email meanwhile
      throw email && /email/i.test(message)
        ? new HttpError(409, 'email_taken', 'Another user has this email address.')
        : new HttpError(409, 'username_taken', 'Another user has this username.');
    }

    throw error;
  }

  if (prehash) {
    await ctx.internalAdapter.linkAccount({
      providerId: 'credential',
      accountId: user.id,
      userId: user.id,
      password: await ctx.password.hash(prehash),
    });
  }

  return user;
};

/**
 * Set a user’s password, creating their password account if needed, and sign them out everywhere.
 * @param {Auth} auth Better Auth instance.
 * @param {string} userId User ID.
 * @param {string} prehash Prehash of the new password.
 * @param {object} options Options.
 * @param {boolean} options.mustChangePassword Whether the user must change it at the next sign-in.
 * @returns {Promise<void>}
 */
export const setPassword = async (auth, userId, prehash, { mustChangePassword }) => {
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(prehash);

  if (await ctx.internalAdapter.findCredentialAccount(userId)) {
    await ctx.internalAdapter.updatePassword(userId, hash);
  } else {
    await ctx.internalAdapter.linkAccount({
      providerId: 'credential',
      accountId: userId,
      userId,
      password: hash,
    });
  }

  await ctx.internalAdapter.updateUser(userId, { mustChangePassword });
  await ctx.internalAdapter.deleteUserSessions(userId);
};
