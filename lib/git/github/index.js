import { deleteSettings } from '../../core/store/settings.js';

import { mintInstallationToken, revokeInstallationToken, withInstallationToken } from './app.js';
import {
  exchangeCode,
  findUserByLogin,
  getAuthenticatedUser,
  getAuthorizeUrl,
  isOrganizationMember,
  refreshTokens,
  revokeUserGrant,
} from './oauth.js';
import { registerGitHubRoutes } from './routes.js';
import {
  getGitHubAppInfo,
  getGitHubConfig,
  getGitHubInstallation,
  GITHUB_SETTINGS,
  updateInstallationName,
} from './settings.js';

/**
 * The GitHub adapter: a GitHub App, created from a manifest and installed on the site’s
 * repository, mints a token per request with the user’s role, and signs people in with GitHub.
 * @import { Database } from '../../types.js';
 * @import { GitProvider, ProviderConnection } from '../../core/git-provider.js';
 * @import { GitHubConfig } from './settings.js';
 */

/**
 * Repository permissions of an installation token, by role. GitHub enforces them, so a viewer’s
 * token can’t write whatever the client does. `workflows`, `administration`, `secrets` and
 * `actions` are never requested.
 * @type {Record<string, Record<string, string>>}
 */
export const ROLE_PERMISSIONS = {
  viewer: { contents: 'read', metadata: 'read', pull_requests: 'read', statuses: 'read' },
  editor: { contents: 'write', metadata: 'read', pull_requests: 'write', statuses: 'read' },
  admin: { contents: 'write', metadata: 'read', pull_requests: 'write', statuses: 'read' },
};

/**
 * Create the connection to GitHub through the app.
 * @param {Database} db Database.
 * @param {GitHubConfig} config App configuration.
 * @returns {ProviderConnection} Connection.
 */
const createConnection = (db, config) => {
  const credentials = { appId: config.id, privateKey: config.privateKey };
  const client = { clientId: config.clientId, clientSecret: config.clientSecret };
  let { installation } = config;

  /**
   * Run a task with a short-lived installation token, revoked right after.
   * @template T
   * @param {Record<string, string>} permissions Permissions.
   * @param {(token: string) => Promise<T>} task Task.
   * @returns {Promise<T>} What the task returns.
   */
  const withToken = (permissions, task) =>
    withInstallationToken(
      credentials,
      {
        installationId: installation.id,
        repositoryId: installation.repositoryId,
        repository: installation.name,
        permissions,
      },
      ({ token }) => task(token),
    );

  /**
   * Get the permissions of a role’s tokens.
   * @param {string} role Role.
   * @returns {Record<string, string>} Permissions.
   */
  const getPermissions = (role) => ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.viewer;

  return {
    /**
     * Get the repository, as last known.
     * @returns {string} Repository, as `owner/name`.
     */
    get repository() {
      return `${installation.owner}/${installation.name}`;
    },
    getPermissions,
    /**
     * Mint an installation token for a role, keeping the repository’s name current.
     * @param {string} role Role.
     * @returns {Promise<import('../../core/git-provider.js').IssuedToken>} Token.
     */
    issueToken: async (role) => {
      const minted = await mintInstallationToken(credentials, {
        installationId: installation.id,
        repositoryId: installation.repositoryId,
        repository: installation.name,
        permissions: getPermissions(role),
      });

      installation = await updateInstallationName(db, installation, minted.repositories);

      return {
        token: minted.token,
        expiresAt: new Date(minted.expiresAt).toISOString(),
        repository: `${installation.owner}/${installation.name}`,
        permissions: minted.permissions,
      };
    },
    /**
     * Look a GitHub user up by name, with an installation token, which has a far higher rate limit
     * than an anonymous request from a shared address.
     * @param {string} login Username.
     * @returns {Promise<{ id: string, login: string } | null>} User.
     */
    findUser: async (login) => {
      const user = await withToken({ metadata: 'read' }, (token) => findUserByLogin(login, token));

      return user ? { id: String(user.id), login: user.login } : null;
    },
    /**
     * Check whether someone belongs to an organization, with a token that can read the members.
     * @param {string} org Organization.
     * @param {string} login Username.
     * @returns {Promise<boolean | null>} Result, or `null` if GitHub couldn’t tell, e.g. while it’s
     * down, which mustn’t count as having left the organization.
     */
    isGroupMember: async (org, login) => {
      try {
        return await withToken({ members: 'read' }, (token) =>
          isOrganizationMember(token, org, login),
        );
      } catch {
        return null;
      }
    },
    signIn: {
      /**
       * @param root0
       * @param root0.redirectUri
       * @param root0.state
       */
      /**
       * Get the URL that asks the user to authorize the app.
       * @param {{ redirectUri: string, state: string }} args Arguments.
       * @returns {string} URL.
       */
      getAuthorizeUrl: ({ redirectUri, state }) =>
        getAuthorizeUrl({ clientId: client.clientId, redirectUri, state }),
      /**
       * @param root0
       * @param root0.code
       * @param root0.redirectUri
       */
      /**
       * Exchange the code GitHub sent back for the user’s tokens.
       * @param {{ code: string, redirectUri: string }} args Arguments.
       * @returns {Promise<import('../../core/git-provider.js').UserTokens>} Tokens.
       */
      exchangeCode: ({ code, redirectUri }) => exchangeCode({ ...client, code, redirectUri }),
      /**
       * Get the GitHub user a token belongs to.
       * @param {string} accessToken Token.
       * @returns {Promise<{ id: string, login: string, name: string | null }>} User.
       */
      getUser: async (accessToken) => {
        const { id, login, name } = await getAuthenticatedUser(accessToken);

        return { id: String(id), login, name: name ?? null };
      },
      /**
       * @param refreshToken
       */
      /**
       * Get new tokens with a refresh token.
       * @param {string} refreshToken Refresh token.
       * @returns {Promise<import('../../core/git-provider.js').UserTokens>} Tokens.
       */
      refreshTokens: (refreshToken) => refreshTokens({ ...client, refreshToken }),
      /**
       * @param accessToken
       */
      /**
       * Revoke the user’s authorization of the app.
       * @param {string} accessToken One of the user’s tokens.
       * @returns {Promise<boolean>} Whether it’s revoked.
       */
      revokeGrant: (accessToken) => revokeUserGrant({ ...client, accessToken }),
    },
  };
};

/** @type {GitProvider} */
export const github = {
  id: 'github',
  /**
   * Get the repository the app is installed on.
   * @param {Database} db Database.
   * @returns {Promise<string | null>} Repository, as `owner/name`.
   */
  getRepository: async (db) => {
    const installation = await getGitHubInstallation(db);

    return installation ? `${installation.owner}/${installation.name}` : null;
  },
  /**
   * Get the app and its installation, for the setup wizard.
   * @param {Database} db Database.
   * @returns {Promise<Record<string, any>>} Status.
   */
  getSetupStatus: async (db) => {
    const [app, installation] = await Promise.all([
      getGitHubAppInfo(db),
      getGitHubInstallation(db),
    ]);

    return {
      github_app: app ? { slug: app.slug, owner: app.owner, html_url: app.htmlUrl } : null,
      installation: installation ? { owner: installation.owner, name: installation.name } : null,
    };
  },
  /**
   * Get the connection through the app, if it’s registered and installed.
   * @param {Database} db Database.
   * @param {import('../../types.js').DataKeys} keys Keys derived from the data key.
   * @returns {Promise<ProviderConnection | null>} Connection.
   */
  connect: async (db, keys) => {
    const config = await getGitHubConfig(db, keys);

    return config ? createConnection(db, config) : null;
  },
  /**
   * Forget the app, which can’t be used without its private key, so it has to be set up again.
   * @param {Database} db Database.
   * @returns {Promise<void>}
   */
  forgetConnection: (db) => deleteSettings(db, [GITHUB_SETTINGS.app, GITHUB_SETTINGS.installation]),
  // An installation token can revoke itself
  /**
   * @param token
   */
  /**
   * Revoke an installation token.
   * @param {string} token Token.
   * @returns {Promise<boolean>} Whether it’s no longer usable.
   */
  revokeToken: (token) => revokeInstallationToken(token),
  /**
   * @param app
   * @param platform
   */
  /**
   * Register the routes that set up and manage the app.
   * @param {import('hono').Hono<import('../../types.js').AppEnv>} app App.
   * @param {import('../../types.js').Platform} platform Platform services.
   * @returns {void}
   */
  registerRoutes: (app, platform) => registerGitHubRoutes(app, platform),
};
