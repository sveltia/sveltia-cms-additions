import { fetchGitHub, GITHUB_TIMEOUT, GitHubError, sendGitHubRequest } from './api.js';

/**
 * Sign-in with GitHub, through the GitHub App’s own OAuth credentials. The tokens it yields are
 * user-to-server tokens: they last 8 hours, come with a refresh token, and can only do what both
 * the app and the user can.
 */

/**
 * Lifetime recorded for a token that doesn’t expire.
 */
const NO_EXPIRY_SECONDS = 365 * 24 * 60 * 60;

/**
 * Usual lifetime of a refresh token, for one GitHub gives none for.
 */
const REFRESH_TOKEN_SECONDS = 184 * 24 * 60 * 60;

/**
 * Origin of GitHub’s OAuth endpoints.
 */
export const GITHUB_WEB_ROOT = 'https://github.com';

/**
 * A user-to-server token, with its refresh token.
 * @typedef {object} UserTokens
 * @property {string} accessToken Access token.
 * @property {string} expiresAt Expiry of the access token, as ISO 8601.
 * @property {string} refreshToken Refresh token, which can only be used once.
 * @property {string} refreshTokenExpiresAt Expiry of the refresh token, as ISO 8601.
 */

/**
 * OAuth credentials of the GitHub App.
 * @typedef {object} OAuthClient
 * @property {string} clientId Client ID.
 * @property {string} clientSecret Client secret.
 */

/**
 * Get the URL that asks the user to authorize the app.
 * @param {object} args Arguments.
 * @param {string} args.clientId Client ID.
 * @param {string} args.redirectUri Callback URL of this service.
 * @param {string} args.state State.
 * @returns {string} URL.
 */
export const getAuthorizeUrl = ({ clientId, redirectUri, state }) => {
  const url = new URL('/login/oauth/authorize', GITHUB_WEB_ROOT);

  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  // Only existing GitHub users can sign in
  url.searchParams.set('allow_signup', 'false');

  return url.toString();
};

/**
 * Request tokens from GitHub’s token endpoint, which answers errors with 200 OK.
 * @param {Record<string, string>} params Form parameters.
 * @returns {Promise<UserTokens>} Tokens.
 * @throws {GitHubError} If GitHub refuses, e.g. because the code has expired.
 */
const requestTokens = async (params) => {
  const response = await fetch(new URL('/login/oauth/access_token', GITHUB_WEB_ROOT), {
    method: 'POST',
    signal: AbortSignal.timeout(GITHUB_TIMEOUT),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'sveltia-cms-additions',
    },
    body: new URLSearchParams(params),
  });

  /** @type {any} */
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.access_token) {
    throw new GitHubError(
      response.status,
      `GitHub refused the token request${result.error ? `: ${result.error}` : ''}.`,
    );
  }

  const now = Date.now();

  return {
    accessToken: result.access_token,
    // A token that doesn’t expire, issued when expiry is turned off for the app, is recorded as
    // lasting a year, so it’s still reused, and revoked when the user’s tokens are, e.g. when
    // they’re signed out everywhere or disabled, rather than counted as gone. Signing out of one
    // session leaves it, as the user’s other sessions share it
    expiresAt: new Date(now + (result.expires_in ?? NO_EXPIRY_SECONDS) * 1000).toISOString(),
    refreshToken: result.refresh_token ?? '',
    // A refresh token GitHub gives no lifetime for lasts as long as its usual six months
    refreshTokenExpiresAt: new Date(
      now + (result.refresh_token_expires_in ?? REFRESH_TOKEN_SECONDS) * 1000,
    ).toISOString(),
  };
};

/**
 * Exchange the code GitHub sent to the callback for tokens.
 * @param {OAuthClient & { code: string, redirectUri: string }} args Arguments.
 * @returns {Promise<UserTokens>} Tokens.
 */
export const exchangeCode = ({ clientId, clientSecret, code, redirectUri }) =>
  requestTokens({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

/**
 * Get new tokens with a refresh token, which is then used up.
 * @param {OAuthClient & { refreshToken: string }} args Arguments.
 * @returns {Promise<UserTokens>} Tokens.
 */
export const refreshTokens = ({ clientId, clientSecret, refreshToken }) =>
  requestTokens({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

/**
 * Get the user a token belongs to.
 * @param {string} token User-to-server token.
 * @returns {Promise<{ id: number, login: string, name: string | null }>} User.
 */
export const getAuthenticatedUser = (token) => fetchGitHub('/user', { auth: `Bearer ${token}` });

/**
 * Look up a GitHub user by name, to record their immutable numeric ID.
 * @param {string} login Username.
 * @param {string} [token] Token to make the request with, for a higher rate limit.
 * @returns {Promise<{ id: number, login: string } | null>} User, or `null` if there is none.
 * @throws {GitHubError} If GitHub fails.
 */
export const findUserByLogin = async (login, token) => {
  try {
    return await fetchGitHub(`/users/${encodeURIComponent(login)}`, {
      ...(token ? { auth: `Bearer ${token}` } : {}),
    });
  } catch (error) {
    if (error instanceof GitHubError && error.githubStatus === 404) {
      return null;
    }

    throw error;
  }
};

/**
 * Check whether a user belongs to an organization, with an installation token that has the
 * `members: read` organization permission.
 * @param {string} token Installation token.
 * @param {string} org Organization.
 * @param {string} login Username.
 * @returns {Promise<boolean>} Result.
 * @throws {GitHubError} If GitHub fails or refuses, e.g. without the permission, or the
 * organization doesn’t exist.
 */
export const isOrganizationMember = async (token, org, login) => {
  const { status } = await sendGitHubRequest(
    `/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(login)}`,
    { auth: `Bearer ${token}` },
  );

  if (status === 204) {
    return true;
  }

  // GitHub answers 404 both for someone who isn’t a member and for an organization that doesn’t
  // exist, e.g. after it was renamed, which mustn’t count as everyone having left it
  if (status === 404) {
    const organization = await sendGitHubRequest(`/orgs/${encodeURIComponent(org)}`, {
      auth: `Bearer ${token}`,
    });

    if (organization.ok) {
      return false;
    }

    throw new GitHubError(organization.status, `GitHub can’t find the organization “${org}”.`);
  }

  throw new GitHubError(status, `GitHub responded with ${status} to a membership check.`);
};

/**
 * Revoke the user’s authorization of the app, which revokes every token it issued them.
 * @param {OAuthClient & { accessToken: string }} args Arguments.
 * @returns {Promise<boolean>} Whether the tokens are no longer usable. `false` if GitHub couldn’t
 * be reached or failed, so it should be retried.
 */
export const revokeUserGrant = async ({ clientId, clientSecret, accessToken }) => {
  try {
    const { status } = await sendGitHubRequest(`/applications/${clientId}/grant`, {
      method: 'DELETE',
      auth: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
      body: { access_token: accessToken },
    });

    // 404 means the grant is gone already. A 422 can mean GitHub is limiting the requests, which
    // leaves the grant in place: it’s tried again
    return status === 204 || status === 404;
  } catch {
    return false;
  }
};
