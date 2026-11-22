import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { generateAppKey, installFakeGitHub } from '../../test/fake-github.js';
import {
  ADMIN_SECRET,
  configureGitHubApp,
  createAdmin,
  createPrehash,
  db,
  requestJson,
  resetState,
  signIn,
} from '../../test/helpers.js';

const ORIGIN = 'https://cms.example';

/** @type {string} */
let adminToken;

beforeEach(async () => {
  await resetState();

  const { prehash } = await createAdmin();

  await requestJson('POST', '/v1/setup/admin', {
    body: { username: 'admin', prehash, allow_origin: true },
    token: ADMIN_SECRET,
    origin: ORIGIN,
  });
  adminToken = await signIn('admin', prehash);
});

describe('GET /v1/settings', () => {
  test('returns the allowed domains', async () => {
    const response = await requestJson('GET', '/v1/settings', {
      token: adminToken,
      origin: ORIGIN,
    });

    await expect(response.json()).resolves.toEqual({
      allowed_domains: ['cms.example'],
      commit_author: 'user',
      sign_in_methods: { github: false },
      sign_up_rules: [],
    });
  });

  test('is for admins only', async () => {
    const temporary = createPrehash();

    await requestJson('POST', '/v1/users', {
      body: { username: 'editor', name: 'Editor', role: 'editor', prehash: temporary },
      token: adminToken,
    });

    const editorToken = await signIn('editor', temporary);
    const changed = await requestJson('POST', '/v1/auth/password', {
      body: { current_prehash: temporary, new_prehash: createPrehash() },
      token: editorToken,
    });
    const response = await requestJson('GET', '/v1/settings', {
      token: (await changed.json()).session_token,
    });

    expect(response.status).toBe(403);
  });
});

describe('PATCH /v1/settings', () => {
  test('replaces the allowed domains', async () => {
    const response = await requestJson('PATCH', '/v1/settings', {
      body: { allowed_domains: ['cms.example', '*.example.org'] },
      token: adminToken,
      origin: ORIGIN,
    });

    await expect(response.json()).resolves.toEqual({
      allowed_domains: ['cms.example', '*.example.org'],
      commit_author: 'user',
      sign_in_methods: { github: false },
      sign_up_rules: [],
    });

    // A site that’s no longer listed can’t use the service
    const later = await requestJson('PATCH', '/v1/settings', {
      body: { allowed_domains: ['*.example.org'] },
      token: adminToken,
      origin: 'https://www.example.org',
    });

    expect(later.status).toBe(200);
    expect(
      (await requestJson('GET', '/v1/settings', { token: adminToken, origin: ORIGIN })).status,
    ).toBe(403);
  });

  test('refuses to remove the site the change is made from', async () => {
    const response = await requestJson('PATCH', '/v1/settings', {
      body: { allowed_domains: ['other.example'] },
      token: adminToken,
      origin: ORIGIN,
    });

    expect(response.status).toBe(409);
  });

  test('validates the input', async () => {
    const invalid = await requestJson('PATCH', '/v1/settings', {
      body: { allowed_domains: ['https://cms.example'] },
      token: adminToken,
      origin: ORIGIN,
    });

    const empty = await requestJson('PATCH', '/v1/settings', {
      body: {},
      token: adminToken,
      origin: ORIGIN,
    });

    expect(invalid.status).toBe(400);
    expect(empty.status).toBe(400);
  });
});

describe('GitHub settings', () => {
  /** @type {Awaited<ReturnType<typeof installFakeGitHub>>} */
  let github;

  beforeEach(async () => {
    github = await installFakeGitHub();
    await configureGitHubApp(github);
  });

  afterEach(() => {
    github.restore();
  });

  /**
   * Upload a private key.
   * @param {any} key Key.
   * @returns {Promise<Response>} Response.
   */
  const uploadKey = (key) =>
    requestJson('PUT', '/v1/settings/github/private-key', {
      body: { private_key: key },
      token: adminToken,
      origin: ORIGIN,
    });

  test('reports the state of the app', async () => {
    const response = await requestJson('GET', '/v1/settings/github', {
      token: adminToken,
      origin: ORIGIN,
    });

    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      default_branch: { name: 'main', protection: 'unprotected' },
    });
  });

  test('replaces a lost private key with one GitHub accepts', async () => {
    await db.run(`DELETE FROM setting WHERE key = 'github_app_private_key'`);

    expect((await uploadKey('not a key')).status).toBe(400);
    // A valid key of another app
    await expect(
      (await uploadKey((await generateAppKey()).pkcs1Pem)).json(),
    ).resolves.toMatchObject({ error: { code: 'private_key_mismatch' } });

    // GitHub issues PKCS#1 keys
    const response = await uploadKey(github.pkcs1Pem);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok' });

    const audit = await db.first(
      `SELECT * FROM audit_log WHERE action = 'github.private_key_replace'`,
    );

    expect(audit).toBeTruthy();
  });

  test('passes on other GitHub errors, and needs an app', async () => {
    const fakeFetch = /** @type {typeof fetch} */ (
      vi.mocked(globalThis.fetch).getMockImplementation()
    );

    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) =>
      new Request(input, init).url === 'https://api.github.com/app'
        ? Response.json({ message: 'Server Error' }, { status: 500 })
        : fakeFetch(input, init),
    );

    expect((await uploadKey(github.pkcs1Pem)).status).toBe(502);

    vi.mocked(globalThis.fetch).mockImplementation(fakeFetch);
    await db.run(`DELETE FROM setting WHERE key = 'github_app'`);

    expect((await uploadKey(github.pkcs1Pem)).status).toBe(409);
  });

  test('chooses the commit author, which the session passes on to the CMS', async () => {
    /**
     * Get the commit author the CMS is told to use.
     * @returns {Promise<any>} Commit author.
     */
    const getCommitAuthor = async () =>
      (await (await requestJson('GET', '/v1/auth/session', { token: adminToken })).json()).git
        .commit_author;

    // A user without an email gets one on the service’s domain
    await expect(getCommitAuthor()).resolves.toEqual({
      mode: 'user',
      name: 'admin',
      email: 'admin@users.noreply.additions.example',
    });

    /**
     * Change the settings.
     * @param {Record<string, any>} body Changes.
     * @returns {Promise<Response>} Response.
     */
    const patch = (body) =>
      requestJson('PATCH', '/v1/settings', { body, token: adminToken, origin: ORIGIN });

    expect((await patch({ commit_author: 'nobody' })).status).toBe(400);
    // Nothing is saved when one of the changes is refused
    expect((await patch({ commit_author: 'bot', allowed_domains: ['other.example'] })).status).toBe(
      409,
    );
    await expect(getCommitAuthor()).resolves.toMatchObject({ mode: 'user' });

    await expect((await patch({ commit_author: 'bot' })).json()).resolves.toEqual({
      allowed_domains: ['cms.example'],
      commit_author: 'bot',
      sign_in_methods: { github: false },
      sign_up_rules: [],
    });
    await db.run(`UPDATE "user" SET email = 'ada@example.com'`);
    await expect(getCommitAuthor()).resolves.toEqual({
      mode: 'bot',
      name: 'admin',
      email: 'ada@example.com',
    });

    // The token refresh passes it on as well
    const refreshed = await requestJson('POST', '/v1/auth/token', {
      body: { grant_type: 'refresh_token', refresh_token: adminToken },
    });

    await expect(refreshed.json()).resolves.toMatchObject({
      git: { commit_author: { mode: 'bot' } },
    });

    // A name saved before line breaks were refused stays on one line in the commit messages
    await db.run(`UPDATE "user" SET name = ?`, ['Ada\nCo-authored-by: Eve <eve@example.com>']);
    await expect(getCommitAuthor()).resolves.toMatchObject({
      name: 'Ada Co-authored-by: Eve <eve@example.com>',
    });
  });

  test('is for admins only', async () => {
    const response = await requestJson('GET', '/v1/settings/github', { origin: ORIGIN });

    expect(response.status).toBe(401);
  });
});
