import { HttpError } from './http/errors.js';
import { getSetting } from './settings.js';

/**
 * The interface between the core and a Git provider, e.g. GitHub. The core only talks to a
 * provider through it; each provider has an adapter under `lib/git/`, which the platform hands to
 * the app. A site uses one provider. See `docs/portability.md` §3.5.
 * @import { Hono } from 'hono';
 * @import { AppEnv, Database, DataKeys, Platform } from '../types.js';
 */

/**
 * A user’s own tokens on the provider, from signing in with it.
 * @typedef {object} UserTokens
 * @property {string} accessToken Access token.
 * @property {string} expiresAt Expiry of the access token, as ISO 8601.
 * @property {string} [refreshToken] Refresh token, which can only be used once.
 * @property {string} [refreshTokenExpiresAt] Expiry of the refresh token, as ISO 8601.
 */

/**
 * A user on the provider.
 * @typedef {object} ProviderUser
 * @property {string} id The provider’s immutable ID of the user, as a string.
 * @property {string} login Username, which can change.
 * @property {string | null} [name] Display name.
 */

/**
 * A token for the site’s repository with a role’s permissions, minted by the service.
 * @typedef {object} IssuedToken
 * @property {string} token Token.
 * @property {string} expiresAt Expiry, as ISO 8601.
 * @property {string} repository Repository, as `owner/name`.
 * @property {Record<string, string>} permissions Permissions granted.
 */

/**
 * Signing in with the provider, as an OAuth client of it.
 * @typedef {object} ProviderSignIn
 * @property {(args: { redirectUri: string, state: string }) => string} getAuthorizeUrl URL that
 * asks the user to authorize the service.
 * @property {(args: { code: string, redirectUri: string }) => Promise<UserTokens>} exchangeCode
 * Exchange the code the provider sent back for the user’s tokens.
 * @property {(accessToken: string) => Promise<ProviderUser>} getUser The user a token belongs to.
 * @property {(refreshToken: string) => Promise<UserTokens>} refreshTokens Get new tokens; throws a
 * {@link ProviderError} with a status below 500 if the refresh token is spent or revoked.
 * @property {(accessToken: string) => Promise<boolean>} revokeGrant Revoke the user’s
 * authorization of the service, and with it every token it issued them.
 */

/**
 * The service’s connection to the provider and the site’s repository, once it’s set up, with the
 * secrets it needs.
 * @typedef {object} ProviderConnection
 * @property {string} repository Repository, as `owner/name`, as last known.
 * @property {(role: string) => Record<string, string>} getPermissions Permissions of a role’s
 * tokens.
 * @property {(role: string) => Promise<IssuedToken>} issueToken Mint a token for a role.
 * @property {(login: string) => Promise<ProviderUser | null>} findUser Look a user up by name.
 * @property {(group: string, login: string) => Promise<boolean | null>} isGroupMember Whether a
 * user belongs to a group, e.g. a GitHub organization, for the sign-up rules; `null` if the
 * provider couldn’t tell.
 * @property {ProviderSignIn} signIn Signing in with the provider.
 */

/**
 * A Git provider adapter.
 * @typedef {object} GitProvider
 * @property {string} id Provider ID, e.g. `github`, which also names its sign-in method and its
 * routes, e.g. `/v1/auth/start/github`.
 * @property {(db: Database) => Promise<string | null>} getRepository The site’s repository, as
 * `owner/name`, once the service is connected to it; this needs no secrets.
 * @property {(db: Database) => Promise<Record<string, any>>} getSetupStatus What has been set up,
 * for the setup wizard, added to `GET /v1/setup/status`, e.g. the GitHub App and its installation.
 * @property {(db: Database, keys: DataKeys) => Promise<ProviderConnection | null>} connect Get the
 * connection, if it’s set up and its secrets can be decrypted.
 * @property {(token: string) => Promise<boolean>} revokeToken Revoke a token the service minted,
 * which works without the connection, e.g. while it’s being replaced; `true` if it’s no longer
 * usable, revoked now or already.
 * @property {(db: Database) => Promise<void>} forgetConnection Forget the connection, e.g. once its
 * secrets can no longer be decrypted after a re-key.
 * @property {(app: Hono<AppEnv>, platform: Platform) => void} registerRoutes Register the routes
 * that set up and manage the connection, e.g. a GitHub App’s.
 */

/**
 * Error returned by a provider’s API.
 */
export class ProviderError extends HttpError {
  /**
   * Create an error.
   * @param {string} code Error code the API answers with, e.g. `github_error`.
   * @param {number} providerStatus Status the provider responded with.
   * @param {string} message Message.
   */
  constructor(code, providerStatus, message) {
    super(502, code, message);
    this.name = 'ProviderError';
    this.providerStatus = providerStatus;
  }
}

/**
 * Setting that names the site’s provider.
 */
export const GIT_PROVIDER_SETTING = 'git_provider';

/**
 * Get the site’s provider among those the deployment has.
 * @param {Database} db Database.
 * @param {GitProvider[]} providers Providers the deployment has, the default first.
 * @returns {Promise<GitProvider>} Provider.
 */
export const getGitProvider = async (db, providers) => {
  // Nothing to choose from, which spares every request a read
  if (providers.length === 1) {
    return providers[0];
  }

  /** @type {string | undefined} */
  const id = await getSetting(db, GIT_PROVIDER_SETTING);

  return providers.find((provider) => provider.id === id) ?? providers[0];
};
