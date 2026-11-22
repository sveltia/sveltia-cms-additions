import { clearAllowedDomainsCache } from '../core/allowed-domains.js';
import { clearDataKeyCache, getDataKeys } from '../core/crypto/data-key.js';
import { toBase64Url } from '../core/crypto/encoding.js';
import { saveGitHubApp, saveGitHubInstallation } from '../git/github/settings.js';

import { FIRST_REPOSITORY_ID } from './fake-github.js';
import { ADMIN_SECRET, db, request, resetPlatform } from './harness.js';

export * from './harness.js';

/**
 * Send a JSON request to the Worker.
 * @param {string} method HTTP method.
 * @param {string} path Path.
 * @param {object} [options] Options.
 * @param {Record<string, any>} [options.body] JSON body.
 * @param {string} [options.token] Bearer token: a session token or the admin secret.
 * @param {string} [options.ip] Client IP address.
 * @param {string} [options.origin] Origin.
 * @returns {Promise<Response>} Response.
 */
export const requestJson = (method, path, { body, token, ip = '198.51.100.1', origin } = {}) =>
  request(path, {
    method,
    headers: {
      'CF-Connecting-IP': ip,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/**
 * Create a random prehash. The server can’t tell it from one derived from a real password.
 * @returns {string} Prehash.
 */
export const createPrehash = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Reset the database and the caches between tests.
 * @returns {Promise<void>}
 */
export const resetState = async () => {
  // Make sure the schema exists before cleaning up
  await request('/version');
  await db.batch(
    [
      'session',
      'account',
      'verification',
      '"user"',
      'setting',
      'data_key',
      'audit_log',
      'issued_token',
      'setup_state',
      'provider_account',
      'auth_flow',
      'auth_code',
      'rule_member',
      'comment',
      'lock',
      'lock_ticket',
      'scheduled_job',
      'presence',
    ].map((table) => ({ sql: `DELETE FROM ${table}` })),
  );
  clearAllowedDomainsCache();
  clearDataKeyCache();
  await resetPlatform();
};

/**
 * Create an admin with the admin secret.
 * @param {string} [username] Username.
 * @returns {Promise<{ prehash: string, user: any }>} Prehash of the password and the created user.
 */
export const createAdmin = async (username = 'admin') => {
  const prehash = createPrehash();
  const response = await requestJson('POST', '/v1/setup/admin', {
    body: { username, prehash },
    token: ADMIN_SECRET,
  });

  return { prehash, user: (await response.json()).user };
};

/**
 * Sign in and return the session token.
 * @param {string} username Username.
 * @param {string} prehash Prehash of the password.
 * @returns {Promise<string>} Session token.
 * @throws {Error} If sign-in fails.
 */
export const signIn = async (username, prehash) => {
  const response = await requestJson('POST', '/v1/auth/sign-in', { body: { username, prehash } });

  if (!response.ok) {
    throw new Error(`Sign-in failed: ${await response.text()}`);
  }

  return (await response.json()).session_token;
};

/**
 * Get the keys derived from the data key, creating it if needed.
 * @returns {Promise<import('../types.js').DataKeys>} Keys.
 * @throws {Error} If the data key is locked.
 */
export const getKeys = async () => {
  const state = await getDataKeys(db, ADMIN_SECRET);

  if (state.status !== 'ok') {
    throw new Error('The data key is locked.');
  }

  return state.keys;
};

/**
 * Set up the GitHub App directly in the database, as the setup flow would, for the given fake
 * GitHub.
 * @param {{ state: any, pkcs8Pem: string }} github Fake GitHub.
 * @returns {Promise<void>}
 */
export const configureGitHubApp = async (github) => {
  await saveGitHubApp(db, await getKeys(), {
    info: {
      id: github.state.appId,
      slug: 'sveltia-cms-site',
      clientId: 'Iv1.client',
      owner: github.state.account,
      htmlUrl: 'https://github.com/apps/sveltia-cms-site',
    },
    privateKey: github.pkcs8Pem,
    clientSecret: 'client-secret',
    webhookSecret: 'webhook-secret',
  });

  await saveGitHubInstallation(db, {
    id: github.state.installationId,
    owner: github.state.account,
    name: github.state.repositories[0],
    repositoryId: FIRST_REPOSITORY_ID,
  });
};
