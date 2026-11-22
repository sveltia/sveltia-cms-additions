import { HttpError } from './http/errors.js';
import { getSetting, setSetting } from './settings.js';

/**
 * @import { Database } from '../types.js';
 */

/**
 * Setting key of the commit author mode.
 */
export const COMMIT_AUTHOR_SETTING = 'commit_author';

/**
 * Who appears as the author of the commits the CMS makes with an installation token: `user`, the
 * person, through the Git Data API, or `bot`, the app, through GraphQL, with the person in a
 * `Co-authored-by` trailer. GitHub signs the app’s commits only, so a ruleset that requires signed
 * commits needs `bot`.
 * @typedef {'user' | 'bot'} CommitAuthorMode
 */

/**
 * Commit author modes.
 * @type {CommitAuthorMode[]}
 */
export const COMMIT_AUTHOR_MODES = ['user', 'bot'];

/**
 * Get the commit author mode.
 * @param {Database} db Database.
 * @returns {Promise<CommitAuthorMode>} Mode. Default: `user`.
 */
export const getCommitAuthorMode = async (db) =>
  (await getSetting(db, COMMIT_AUTHOR_SETTING)) ?? 'user';

/**
 * Check a commit author mode.
 * @param {unknown} mode Mode.
 * @returns {CommitAuthorMode} Mode.
 * @throws {HttpError} If the mode is unknown.
 */
export const validateCommitAuthorMode = (mode) => {
  if (!COMMIT_AUTHOR_MODES.includes(/** @type {any} */ (mode))) {
    throw new HttpError(400, 'invalid_commit_author', 'The commit author must be `user` or `bot`.');
  }

  return /** @type {CommitAuthorMode} */ (mode);
};

/**
 * Set the commit author mode.
 * @param {Database} db Database.
 * @param {CommitAuthorMode} mode Mode, checked with {@link validateCommitAuthorMode}.
 * @param {{ actorId: string }} options Options.
 * @returns {Promise<void>}
 */
export const setCommitAuthorMode = (db, mode, { actorId }) =>
  setSetting(db, COMMIT_AUTHOR_SETTING, mode, { actorId });

/**
 * Get how the CMS should author a user’s commits.
 * @param {Database} db Database.
 * @param {{ username: string, name: string, email: string | null }} user User, as the API returns
 * them.
 * @param {string} hostname Hostname of this service.
 * @returns {Promise<{ mode: CommitAuthorMode, name: string, email: string }>} Mode, and the name
 * and email to use as the author or co-author. A user without an email gets an address on this
 * service’s domain, which can’t belong to someone else’s GitHub account.
 */
export const getCommitAuthor = async (db, { username, name, email }, hostname) => ({
  mode: await getCommitAuthorMode(db),
  // A name saved before control characters were refused, or taken from GitHub, is kept on one
  // line, as it goes into commit messages, e.g. in a `Co-authored-by` trailer
  name: name.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim(),
  email: email ?? `${username}@users.noreply.${hostname}`,
});
