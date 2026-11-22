import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ADMIN_SECRET,
  createPrehash,
  db,
  listen,
  requestJson,
  resetState,
  signIn,
} from '../../test/helpers.js';

const ORIGIN = 'https://cms.example';

const CREDENTIALS = {
  api_keys: { deepl: 'abc:fx', 'cloudflare-r2': 'r2-secret' },
  deploy_hook: { url: 'https://api.netlify.com/build_hooks/1', auth_header: '' },
};

/** @type {string} */
let adminToken;

/**
 * Send a request as a user.
 * @param {string} token Session token.
 * @param {string} method Method.
 * @param {string} path Path.
 * @param {Record<string, any>} [body] Body.
 * @returns {Promise<Response>} Response.
 */
const send = (token, method, path, body) =>
  requestJson(method, path, { body, token, origin: ORIGIN });

/**
 * Create a user who has changed their temporary password, and sign them in.
 * @param {string} username Username.
 * @param {string} role Role.
 * @returns {Promise<string>} Session token.
 */
const createSignedInUser = async (username, role) => {
  const temporary = createPrehash();

  await send(adminToken, 'POST', '/v1/users', {
    username,
    name: username.toUpperCase(),
    role,
    prehash: temporary,
  });

  const changed = await requestJson('POST', '/v1/auth/password', {
    body: { current_prehash: temporary, new_prehash: createPrehash() },
    token: await signIn(username, temporary),
  });

  return (await changed.json()).session_token;
};

/**
 * Open a tab’s connection, and collect what it receives.
 * @param {string} token Session token.
 * @returns {Promise<any[]>} Messages received, filled in as they come.
 */
const listenAs = (token) => listen(token, ORIGIN);

beforeEach(async () => {
  await resetState();

  const prehash = createPrehash();

  await requestJson('POST', '/v1/setup/admin', {
    body: { username: 'admin', prehash, allow_origin: true },
    token: ADMIN_SECRET,
    origin: ORIGIN,
  });
  adminToken = await signIn('admin', prehash);
});

describe('credentials', () => {
  test('are set by an admin, and handed to every signed-in user', async () => {
    const viewerToken = await createSignedInUser('vic', 'viewer');
    const messages = await listenAs(viewerToken);

    // Nothing yet
    await expect((await send(viewerToken, 'GET', '/v1/credentials')).json()).resolves.toEqual({
      api_keys: {},
      deploy_hook: null,
    });

    const saved = await send(adminToken, 'PUT', '/v1/settings/credentials', CREDENTIALS);

    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toEqual(CREDENTIALS);
    // Open tabs are told to load them again, without the values
    await vi.waitFor(() => expect(messages).toContainEqual({ type: 'credentials' }));
    expect(JSON.stringify(messages)).not.toContain('abc:fx');
    await expect((await send(viewerToken, 'GET', '/v1/credentials')).json()).resolves.toEqual(
      CREDENTIALS,
    );

    // Stored encrypted, and logged without the values
    const setting = await db.first('SELECT value, ciphertext FROM setting WHERE key = ?', [
      'credentials',
    ]);

    expect(setting?.value).toBeNull();
    expect(setting?.ciphertext).not.toContain('abc:fx');

    const audit = await db.first('SELECT meta FROM audit_log WHERE action = ?', [
      'settings.credentials',
    ]);

    expect(JSON.parse(String(audit?.meta))).toEqual({
      api_keys: ['deepl', 'cloudflare-r2'],
      deploy_hook: true,
    });

    // Saving again replaces them all
    await send(adminToken, 'PUT', '/v1/settings/credentials', { api_keys: { google: 'px' } });
    await expect((await send(viewerToken, 'GET', '/v1/credentials')).json()).resolves.toEqual({
      api_keys: { google: 'px' },
      deploy_hook: null,
    });
  });

  test('can only be changed by an admin', async () => {
    const editorToken = await createSignedInUser('eddie', 'editor');
    const response = await send(editorToken, 'PUT', '/v1/settings/credentials', CREDENTIALS);

    expect(response.status).toBe(403);
    await expect((await send(editorToken, 'GET', '/v1/credentials')).json()).resolves.toEqual({
      api_keys: {},
      deploy_hook: null,
    });
  });

  test('need a session', async () => {
    expect((await requestJson('GET', '/v1/credentials', { origin: ORIGIN })).status).toBe(401);
  });

  test('refuse invalid input', async () => {
    const response = await send(adminToken, 'PUT', '/v1/settings/credentials', {
      deploy_hook: { url: 'http://example.com/hook' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_credentials' },
    });
  });
});
