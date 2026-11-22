import { toBase64Url, toUtf8 } from '../../core/crypto/encoding.js';

import { fetchGitHub, sendGitHubRequest } from './api.js';
import { readPrivateKey } from './pem.js';

/**
 * Credentials of the GitHub App.
 * @typedef {object} GitHubAppCredentials
 * @property {number} appId App ID.
 * @property {string} privateKey PEM-encoded private key.
 */

/**
 * An installation access token.
 * @typedef {object} InstallationToken
 * @property {string} token Token.
 * @property {string} expiresAt Expiry, as ISO 8601.
 * @property {Record<string, string>} permissions Granted permissions.
 * @property {{ id: number, full_name: string }[]} repositories Repositories the token can access.
 */

/**
 * Imported signing keys, by PEM.
 * @type {Map<string, Promise<CryptoKey>>}
 */
const keyCache = new Map();

/**
 * Import the app’s private key for RS256 signing.
 * @param {string} pem PEM-encoded private key.
 * @returns {Promise<CryptoKey>} Key.
 */
const importSigningKey = (pem) => {
  let key = keyCache.get(pem);

  if (!key) {
    key = crypto.subtle.importKey(
      'pkcs8',
      readPrivateKey(pem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    keyCache.clear();
    keyCache.set(pem, key);
  }

  return key;
};

/**
 * Create a JSON Web Token that authenticates as the app. It’s valid for nine minutes, starting a
 * minute in the past to allow for clock drift, which is within GitHub’s ten-minute limit.
 * @param {GitHubAppCredentials} credentials App credentials.
 * @returns {Promise<string>} JWT.
 */
export const createAppJwt = async ({ appId, privateKey }) => {
  const now = Math.floor(Date.now() / 1000);

  /**
   * Encode a JWT part.
   * @param {object} value Header or payload.
   * @returns {string} Base64url-encoded JSON.
   */
  const encodeJson = (value) => toBase64Url(toUtf8(JSON.stringify(value)));

  const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({
    iat: now - 60,
    exp: now + 8 * 60,
    iss: String(appId),
  })}`;

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await importSigningKey(privateKey),
    toUtf8(unsigned),
  );

  return `${unsigned}.${toBase64Url(signature)}`;
};

/**
 * Get the app, which only works with a JWT signed by its private key.
 * @param {GitHubAppCredentials} credentials App credentials.
 * @returns {Promise<{ id: number, slug: string, owner: { login: string, type: string } }>} App.
 * @throws {import('./api.js').GitHubError} If GitHub refuses, e.g. because the key isn’t the
 * app’s (401).
 */
export const getApp = async (credentials) =>
  fetchGitHub('/app', { auth: `Bearer ${await createAppJwt(credentials)}` });

/**
 * Get an installation of the app.
 * @param {GitHubAppCredentials} credentials App credentials.
 * @param {number} installationId Installation ID.
 * @returns {Promise<{ id: number, account: { login: string, type: string }, suspended_at?:
 * string | null }>} Installation.
 */
export const getInstallation = async (credentials, installationId) =>
  fetchGitHub(`/app/installations/${installationId}`, {
    auth: `Bearer ${await createAppJwt(credentials)}`,
  });

/**
 * Mint an installation access token limited to one repository and the given permissions. Tokens
 * last one hour, and GitHub enforces both limits. The repository is named by its ID when known,
 * which unlike its name survives a rename.
 * @param {GitHubAppCredentials} credentials App credentials.
 * @param {object} args Arguments.
 * @param {number} args.installationId Installation ID.
 * @param {number} [args.repositoryId] Repository ID. `0` or missing when unknown.
 * @param {string} args.repository Repository name, without the owner, used without an ID.
 * @param {Record<string, string>} args.permissions Permissions, e.g. `{ contents: 'read' }`.
 * @returns {Promise<InstallationToken>} Token.
 * @throws {import('./api.js').GitHubError} If GitHub refuses, e.g. because the installation
 * doesn’t include the repository (422).
 */
export const mintInstallationToken = async (
  credentials,
  { installationId, repositoryId, repository, permissions },
) => {
  /** @type {any} */
  const result = await fetchGitHub(`/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    auth: `Bearer ${await createAppJwt(credentials)}`,
    body: repositoryId
      ? { repository_ids: [repositoryId], permissions }
      : { repositories: [repository], permissions },
  });

  return {
    token: result.token,
    expiresAt: result.expires_at,
    permissions: result.permissions,
    repositories: result.repositories ?? [],
  };
};

/**
 * Revoke an installation access token. It’s revoked with the token itself, so the caller needs it.
 * @param {string} token Token.
 * @returns {Promise<boolean>} Whether the token is no longer usable: revoked now, or already
 * expired or revoked. `false` if GitHub couldn’t be reached or failed, so it should be retried.
 */
export const revokeInstallationToken = async (token) => {
  try {
    const { status } = await sendGitHubRequest('/installation/token', {
      method: 'DELETE',
      auth: `Bearer ${token}`,
    });

    return status === 204 || status === 401;
  } catch {
    return false;
  }
};

/**
 * Run a task with an installation access token minted for it, which is revoked once the task is
 * done, whether it worked or not, as it’s only needed for the task. See {@link mintInstallationToken}
 * for the arguments.
 * @template T
 * @param {GitHubAppCredentials} credentials App credentials.
 * @param {Parameters<typeof mintInstallationToken>[1]} args Arguments.
 * @param {(token: InstallationToken) => Promise<T>} task Task, which gets the token.
 * @returns {Promise<T>} What the task returns.
 * @throws {import('./api.js').GitHubError} If GitHub refuses to mint the token. The task’s own
 * errors are thrown too.
 */
export const withInstallationToken = async (credentials, args, task) => {
  const minted = await mintInstallationToken(credentials, args);

  try {
    return await task(minted);
  } finally {
    await revokeInstallationToken(minted.token);
  }
};

/**
 * Exchange the code from the app manifest flow for the new app’s credentials. The code is valid
 * for one hour and needs no other authentication.
 * @param {string} code Code.
 * @returns {Promise<any>} App, with `id`, `slug`, `client_id`, `client_secret`, `webhook_secret`,
 * `pem`, `owner` and `html_url`.
 */
export const convertManifestCode = (code) =>
  fetchGitHub(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });

/**
 * Get whether a GitHub account is an organization or a user.
 * @param {string} login Account name.
 * @returns {Promise<'Organization' | 'User'>} Account type.
 */
export const getAccountType = async (login) => {
  /** @type {any} */
  const account = await fetchGitHub(`/users/${encodeURIComponent(login)}`);

  return account.type === 'Organization' ? 'Organization' : 'User';
};
