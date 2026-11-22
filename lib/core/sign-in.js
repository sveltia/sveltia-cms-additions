import { HttpError } from './http/errors.js';
import { getSetting } from './settings.js';

/**
 * @import { Database } from '../types.js';
 */

/**
 * Setting key of the sign-in methods turned on besides the password.
 */
export const SIGN_IN_METHODS_SETTING = 'sign_in_methods';

/**
 * Setting key of the sign-up rules.
 */
export const SIGN_UP_RULES_SETTING = 'sign_up_rules';

/**
 * Sign-in methods besides the password, which is always on.
 * @typedef {object} SignInMethods
 * @property {boolean} github Whether people can sign in with GitHub.
 */

/**
 * A rule that creates an account for someone who signs in without one. It can only create a new
 * account, never attach someone to an existing one, and it never gives the `admin` role.
 * @typedef {object} SignUpRule
 * @property {string} id ID.
 * @property {'github_org'} type Type: members of a GitHub organization.
 * @property {string} org Organization, which the GitHub App has to be installed on.
 * @property {'editor' | 'viewer'} role Role of the accounts it creates.
 */

/**
 * A GitHub organization name.
 */
const ORG_REGEX = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

/**
 * Get the sign-in methods.
 * @param {Database} db Database.
 * @returns {Promise<SignInMethods>} Methods. All off by default.
 */
export const getSignInMethods = async (db) => ({
  github: false,
  ...(await getSetting(db, SIGN_IN_METHODS_SETTING)),
});

/**
 * Check the sign-in methods sent by an admin.
 * @param {unknown} value Value.
 * @returns {SignInMethods} Methods.
 * @throws {HttpError} If they’re invalid.
 */
export const validateSignInMethods = (value) => {
  const { github } = /** @type {any} */ (value ?? {});

  if (typeof github !== 'boolean') {
    throw new HttpError(
      400,
      'invalid_sign_in_methods',
      '`sign_in_methods.github` must be a boolean.',
    );
  }

  return { github };
};

/**
 * Get the sign-up rules.
 * @param {Database} db Database.
 * @returns {Promise<SignUpRule[]>} Rules. None by default, so admins create everyone.
 */
export const getSignUpRules = async (db) => (await getSetting(db, SIGN_UP_RULES_SETTING)) ?? [];

/**
 * Check the sign-up rules sent by an admin. An organization rule needs the GitHub App installed on
 * the organization, which is the only way the service can check who belongs to it.
 * @param {unknown} value Value.
 * @param {string | null} repository The site’s repository, as `owner/name`, if the provider is set
 * up.
 * @returns {SignUpRule[]} Rules.
 * @throws {HttpError} If they’re invalid.
 */
export const validateSignUpRules = (value, repository) => {
  if (!Array.isArray(value) || value.length > 20) {
    throw new HttpError(400, 'invalid_rules', '`sign_up_rules` must be a list of up to 20 rules.');
  }

  return value.map((rule) => {
    const { id, type, org, role } = rule ?? {};

    if (type !== 'github_org' || typeof org !== 'string' || !ORG_REGEX.test(org)) {
      throw new HttpError(400, 'invalid_rules', 'A rule needs a GitHub organization name.');
    }

    if (role !== 'editor' && role !== 'viewer') {
      throw new HttpError(
        400,
        'invalid_rule_role',
        'A rule gives the editor or viewer role. Promote someone to admin by hand.',
      );
    }

    if (org.toLowerCase() !== repository?.split('/')[0].toLowerCase()) {
      throw new HttpError(
        400,
        'rule_org_not_installed',
        'The GitHub App has to be installed on the organization of the rule.',
      );
    }

    return {
      id: typeof id === 'string' && id ? id : crypto.randomUUID(),
      type,
      org: org.toLowerCase(),
      role,
    };
  });
};
