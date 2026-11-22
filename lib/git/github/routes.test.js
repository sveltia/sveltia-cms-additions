import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { installFakeGitHub } from '../../test/fake-github.js';
import {
  ADMIN_SECRET,
  createAdmin,
  db,
  request,
  requestJson,
  resetState,
} from '../../test/helpers.js';

import { getAppName } from './routes.js';

const RETURN_URL = 'https://cms.example/admin/#/collections/posts';

/** @type {Awaited<ReturnType<typeof installFakeGitHub>>} */
let github;

/**
 * Start a setup run, as the CMS does.
 * @param {Record<string, any>} [body] Body overrides.
 * @returns {Promise<Response>} Response.
 */
const startSetup = (body = {}) =>
  requestJson('POST', '/v1/setup/github', {
    body: { repo: 'sveltia/site', return_url: RETURN_URL, ...body },
    token: ADMIN_SECRET,
    origin: 'https://cms.example',
  });

/**
 * Run the setup up to GitHub sending the browser back after installing the app.
 * @returns {Promise<string>} State of the run.
 */
const createApp = async () => {
  const { action_url: actionUrl } = await (await startSetup()).json();
  const state = /** @type {string} */ (new URL(actionUrl).searchParams.get('state'));

  await request(`/v1/setup/github/callback?code=good-code&state=${state}`, { redirect: 'manual' });

  return state;
};

beforeEach(async () => {
  await resetState();
  github = await installFakeGitHub();
});

afterEach(() => {
  github.restore();
});

describe('getAppName()', () => {
  test('names the owner and the repository, and ends with part of the site ID', () => {
    const siteId = '7f3a91c2-0000-4000-8000-000000000000';

    expect(getAppName('acme/website', siteId)).toBe('Sveltia CMS acme website 7f3a');
    // Cut to GitHub’s limit of 34 characters, keeping the suffix
    expect(getAppName('a-very-long-organization/site', siteId)).toBe(
      'Sveltia CMS a-very-long-organ 7f3a',
    );
    expect(getAppName('an-even-longer-company-name/site', siteId)).toHaveLength(34);
  });
});

describe('POST /v1/setup/github', () => {
  test('returns a manifest to submit to GitHub', async () => {
    const response = await startSetup();
    const { action_url: actionUrl, manifest } = await response.json();
    const url = new URL(actionUrl);

    expect(response.status).toBe(200);
    expect(`${url.origin}${url.pathname}`).toBe('https://github.com/settings/apps/new');
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{32}$/);
    expect(manifest).toMatchObject({
      name: expect.stringMatching(/^Sveltia CMS sveltia site [\da-f]{4}$/),
      public: false,
      redirect_url: 'https://additions.example/v1/setup/github/callback',
      setup_url: 'https://additions.example/v1/setup/github/installed',
      callback_urls: ['https://additions.example/v1/auth/callback/github'],
      default_permissions: {
        contents: 'write',
        metadata: 'read',
        pull_requests: 'write',
        statuses: 'read',
      },
    });
    expect(manifest.default_permissions).not.toHaveProperty('workflows');
  });

  test('uses the organization’s settings for an organization repository', async () => {
    github.restore();
    github = await installFakeGitHub({ accountType: 'Organization' });

    const { action_url: actionUrl } = await (await startSetup()).json();

    expect(new URL(actionUrl).pathname).toBe('/organizations/sveltia/settings/apps/new');
  });

  test('validates the input', async () => {
    const codes = await Promise.all(
      [
        { repo: 'site' },
        { return_url: 'https://elsewhere.example/admin/' },
        { return_url: 'ftp://cms.example/admin/' },
      ].map(async (body) => (await (await startSetup(body)).json()).error.code),
    );

    expect(codes).toEqual(['invalid_repository', 'invalid_return_url', 'invalid_return_url']);
  });

  test('requires the admin secret', async () => {
    const response = await requestJson('POST', '/v1/setup/github', {
      body: { repo: 'sveltia/site', return_url: RETURN_URL },
      token: 'wrong',
    });

    expect(response.status).toBe(401);
  });

  test('refuses to replace an app unless asked', async () => {
    await createApp();

    expect((await startSetup()).status).toBe(409);
    expect((await startSetup({ replace: true })).status).toBe(200);
  });
});

describe('the manifest callback', () => {
  test('stores the app’s credentials encrypted and goes on to install it', async () => {
    const { action_url: actionUrl } = await (await startSetup()).json();
    const state = new URL(actionUrl).searchParams.get('state');
    const response = await request(`/v1/setup/github/callback?code=good-code&state=${state}`, {
      redirect: 'manual',
    });
    const location = new URL(/** @type {string} */ (response.headers.get('location')));

    expect(response.status).toBe(303);
    expect(`${location.origin}${location.pathname}`).toBe(
      'https://github.com/apps/sveltia-cms-site/installations/new',
    );
    expect(location.searchParams.get('state')).toBe(state);

    const settings = await db.all('SELECT key, value, ciphertext FROM setting ORDER BY key');
    const privateKey = settings.find(({ key }) => key === 'github_app_private_key');

    expect(privateKey.value).toBeNull();
    expect(privateKey.ciphertext).not.toContain('PRIVATE KEY');
    expect(JSON.parse(settings.find(({ key }) => key === 'github_app').value)).toMatchObject({
      id: 101,
      slug: 'sveltia-cms-site',
    });
  });

  test('revokes the tokens of the app it replaces', async () => {
    await createApp();

    const { user } = await createAdmin();

    // A token the previous app issued
    await db.run(
      'INSERT INTO issued_token (id, user_id, session_id, kind, role, token_hash, ' +
        'token_ciphertext, issued_at, expires_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)',
      [
        'old-token',
        user.id,
        'installation',
        'admin',
        'hash',
        'ciphertext',
        Date.now(),
        Date.now() + 60 * 60 * 1000,
      ],
    );

    const { action_url: actionUrl } = await (await startSetup({ replace: true })).json();
    const state = new URL(actionUrl).searchParams.get('state');

    await request(`/v1/setup/github/callback?code=good-code&state=${state}`, {
      redirect: 'manual',
    });

    await expect(
      db.first("SELECT revoke_requested_at FROM issued_token WHERE id = 'old-token'"),
    ).resolves.toMatchObject({ revoke_requested_at: expect.any(Number) });
  });

  test('lets a run be tried again after a failure', async () => {
    const { action_url: actionUrl } = await (await startSetup()).json();
    const state = new URL(actionUrl).searchParams.get('state');
    const callback = (code) =>
      request(`/v1/setup/github/callback?code=${code}&state=${state}`, { redirect: 'manual' });

    expect((await callback('bad-code')).status).not.toBe(303);
    expect((await callback('good-code')).status).toBe(303);
    // The run has moved on to the installation
    expect((await callback('good-code')).status).toBe(400);
  });

  test('refuses an unknown state', async () => {
    const response = await request('/v1/setup/github/callback?code=good-code&state=forged');

    expect(response.status).toBe(400);
  });

  test('returns to the CMS when the app wasn’t created', async () => {
    const { action_url: actionUrl } = await (await startSetup()).json();
    const state = new URL(actionUrl).searchParams.get('state');
    const response = await request(`/v1/setup/github/callback?state=${state}`, {
      redirect: 'manual',
    });

    expect(response.headers.get('location')).toBe(
      'https://cms.example/admin/?additions_setup=github_app_not_created#/collections/posts',
    );
  });
});

describe('the installation callback', () => {
  test('records the installation and returns to the CMS', async () => {
    const state = await createApp();
    const response = await request(
      `/v1/setup/github/installed?installation_id=202&setup_action=install&state=${state}`,
      { redirect: 'manual' },
    );

    expect(response.headers.get('location')).toBe(
      'https://cms.example/admin/?additions_setup=ok#/collections/posts',
    );

    const { setup } = await (await request('/version')).json();

    expect(setup.github_app).toBe(true);

    // The probe token used to check the repository was revoked straight away
    expect(github.state.revoked.size).toBe(1);

    // The run can’t be replayed
    const replay = await request(
      `/v1/setup/github/installed?installation_id=202&setup_action=install&state=${state}`,
    );

    expect(replay.status).toBe(400);
  });

  test('reports an installation that doesn’t include the repository', async () => {
    github.state.repositories = ['other'];

    const state = await createApp();
    const response = await request(
      `/v1/setup/github/installed?installation_id=202&setup_action=install&state=${state}`,
      { redirect: 'manual' },
    );

    expect(response.headers.get('location')).toContain(
      'additions_setup=github_repository_not_included',
    );

    const { setup } = await (await request('/version')).json();

    expect(setup.github_app).toBe(false);
  });

  test('reports an installation on another account', async () => {
    const { action_url: actionUrl } = await (
      await startSetup({ repo: 'someone-else/site' })
    ).json();
    const state = new URL(actionUrl).searchParams.get('state');

    await request(`/v1/setup/github/callback?code=good-code&state=${state}`, {
      redirect: 'manual',
    });

    const response = await request(
      `/v1/setup/github/installed?installation_id=202&setup_action=install&state=${state}`,
      { redirect: 'manual' },
    );

    expect(response.headers.get('location')).toContain('additions_setup=github_wrong_account');
  });
});
