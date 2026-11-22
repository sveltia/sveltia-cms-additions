import { getSecretSetting } from '../../core/settings.js';

import { GitHubError } from './api.js';
import { getApp, getInstallation, withInstallationToken } from './app.js';
import { getDefaultBranchProtection } from './repository.js';
import {
  getAppSettingsUrl,
  getGitHubAppInfo,
  getGitHubInstallation,
  GITHUB_SETTINGS,
  updateInstallationName,
} from './settings.js';

/**
 * @import { Database, DataKeys } from '../../types.js';
 * @import { BranchProtection } from './repository.js';
 */

/**
 * State of the connection to GitHub:
 * - `not_registered`: no app has been registered;
 * - `key_missing`: the private key was lost when the data key was replaced;
 * - `key_rejected`: GitHub doesn’t accept the private key, e.g. because it was deleted there;
 * - `not_installed`: the app isn’t installed on the repository (any more);
 * - `suspended`: the installation is suspended;
 * - `unreachable`: GitHub couldn’t be reached or failed;
 * - `ok`: everything works.
 * @typedef {'not_registered' | 'key_missing' | 'key_rejected' | 'not_installed' | 'suspended' |
 * 'unreachable' | 'ok'} GitHubConnectionStatus
 */

/**
 * GitHub settings and their state, as the API returns them.
 * @typedef {object} GitHubStatus
 * @property {GitHubConnectionStatus} status Connection state.
 * @property {{ id: number, slug: string, owner: string, html_url: string, settings_url: string }
 * | null} app Registered app.
 * @property {{ owner: string, name: string } | null} installation Repository the app is installed
 * on.
 * @property {{ name: string, protection: BranchProtection } | null} default_branch Default branch
 * and its protection, when it could be checked.
 */

/**
 * Check the GitHub App with GitHub: whether its private key works, whether it’s still installed on
 * the repository, and whether rulesets protect the default branch.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @returns {Promise<GitHubStatus>} Status.
 */
export const getGitHubStatus = async (db, keys) => {
  const [info, storedInstallation, privateKey] = await Promise.all([
    getGitHubAppInfo(db),
    getGitHubInstallation(db),
    getSecretSetting(db, keys, GITHUB_SETTINGS.privateKey),
  ]);

  if (!info) {
    return { status: 'not_registered', app: null, installation: null, default_branch: null };
  }

  // Updated below if the repository has been renamed
  let installation = storedInstallation;

  /**
   * Build the result.
   * @param {GitHubConnectionStatus} status Status.
   * @param {GitHubStatus['default_branch']} [defaultBranch] Default branch.
   * @returns {GitHubStatus} Result.
   */
  const result = (status, defaultBranch = null) => ({
    status,
    app: {
      id: info.id,
      slug: info.slug,
      owner: info.owner,
      html_url: info.htmlUrl,
      settings_url: getAppSettingsUrl(info),
    },
    installation: installation ? { owner: installation.owner, name: installation.name } : null,
    default_branch: defaultBranch,
  });

  if (!privateKey) {
    return result('key_missing');
  }

  const credentials = { appId: info.id, privateKey };

  /**
   * Map an error to a status. Anything but an error response, e.g. a network error, means GitHub
   * couldn’t be reached.
   * @param {unknown} error Error.
   * @param {Record<number, GitHubConnectionStatus>} statuses Status by GitHub’s response status.
   * @returns {GitHubStatus} Result.
   */
  const fail = (error, statuses) =>
    result(
      (error instanceof GitHubError ? statuses[error.githubStatus] : undefined) ?? 'unreachable',
    );

  try {
    await getApp(credentials);
  } catch (error) {
    return fail(error, { 401: 'key_rejected' });
  }

  if (!installation) {
    return result('not_installed');
  }

  try {
    if ((await getInstallation(credentials, installation.id)).suspended_at) {
      return result('suspended');
    }

    return await withInstallationToken(
      credentials,
      {
        installationId: installation.id,
        repositoryId: installation.repositoryId,
        repository: installation.name,
        permissions: { metadata: 'read' },
      },
      async ({ token, repositories }) => {
        installation = await updateInstallationName(db, installation, repositories);

        try {
          return result('ok', await getDefaultBranchProtection(token, installation));
        } catch {
          // The app works; only the check failed
          return result('ok');
        }
      },
    );
  } catch (error) {
    // 404: the app was uninstalled; 422: the repository was removed from the installation
    return fail(error, { 404: 'not_installed', 422: 'not_installed' });
  }
};
