import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { generateAppKey, installFakeGitHub } from '../../test/fake-github.js';
import { configureGitHubApp, db, getKeys, resetState } from '../../test/helpers.js';

import { getGitHubStatus } from './status.js';

/** @type {Awaited<ReturnType<typeof installFakeGitHub>>} */
let github;

beforeEach(async () => {
  await resetState();
  github = await installFakeGitHub();
});

afterEach(() => {
  github.restore();
});

/**
 * Get the status.
 * @returns {Promise<import('./status.js').GitHubStatus>} Status.
 */
const getStatus = async () => getGitHubStatus(db, await getKeys());

describe('getGitHubStatus', () => {
  test('reports a missing app', async () => {
    await expect(getStatus()).resolves.toEqual({
      status: 'not_registered',
      app: null,
      installation: null,
      default_branch: null,
    });
  });

  test('checks the app, its installation and the default branch, then revokes the token', async () => {
    await configureGitHubApp(github);
    github.state.rulesets = [{ id: 1, rules: ['non_fast_forward', 'deletion', 'creation'] }];

    await expect(getStatus()).resolves.toEqual({
      status: 'ok',
      app: {
        id: 101,
        slug: 'sveltia-cms-site',
        owner: 'sveltia',
        html_url: 'https://github.com/apps/sveltia-cms-site',
        settings_url: 'https://github.com/settings/apps/sveltia-cms-site',
      },
      installation: { owner: 'sveltia', name: 'site' },
      default_branch: { name: 'main', protection: 'protected' },
    });

    // The token can only read metadata, and is revoked straight away
    const [[token, { permissions }]] = [...github.state.tokens];

    expect(permissions).toEqual({ metadata: 'read' });
    expect(github.state.revoked.has(token)).toBe(true);
  });

  test('checks a renamed repository under its new name', async () => {
    await configureGitHubApp(github);
    github.state.repositories = ['website'];

    // The branch check reads the repository by its new name
    await expect(getStatus()).resolves.toMatchObject({
      status: 'ok',
      installation: { owner: 'sveltia', name: 'website' },
      default_branch: { name: 'main' },
    });
  });

  test('tells whether rulesets protect the default branch from the app', async () => {
    await configureGitHubApp(github);

    /**
     * Get the protection with the given rulesets.
     * @param {{ id: number, rules: string[], bypass?: string }[]} rulesets Rulesets.
     * @returns {Promise<string | undefined>} Protection.
     */
    const getProtection = async (rulesets) => {
      github.state.rulesets = rulesets;

      return (await getStatus()).default_branch?.protection;
    };

    await expect(getProtection([])).resolves.toBe('unprotected');
    await expect(getProtection([{ id: 1, rules: ['deletion'] }])).resolves.toBe('unprotected');
    // Two rulesets can share the work
    await expect(
      getProtection([
        { id: 1, rules: ['deletion'] },
        { id: 2, rules: ['non_fast_forward'], bypass: 'pull_requests_only' },
      ]),
    ).resolves.toBe('protected');
    await expect(
      getProtection([{ id: 1, rules: ['deletion', 'non_fast_forward'], bypass: 'always' }]),
    ).resolves.toBe('bypassed');
    // A rule the app can bypass is made up for by another one it can’t
    await expect(
      getProtection([
        { id: 1, rules: ['deletion', 'non_fast_forward'], bypass: 'always' },
        { id: 2, rules: ['non_fast_forward', 'deletion'] },
      ]),
    ).resolves.toBe('protected');

    // A default branch can have slashes in its name
    github.state.defaultBranch = 'release/main';

    await expect(getProtection([{ id: 1, rules: ['deletion', 'non_fast_forward'] }])).resolves.toBe(
      'protected',
    );
  });

  test('links to the settings of an app owned by an organization', async () => {
    await configureGitHubApp(github);
    await db.run(`UPDATE setting SET value = json_set(value, '$.ownerType', 'Organization')
      WHERE key = 'github_app'`);

    await expect(getStatus()).resolves.toMatchObject({
      app: {
        settings_url: 'https://github.com/organizations/sveltia/settings/apps/sveltia-cms-site',
      },
    });
  });

  test('reports a lost or rejected private key', async () => {
    await configureGitHubApp(github);
    await db.run(`DELETE FROM setting WHERE key = 'github_app_private_key'`);

    await expect(getStatus()).resolves.toMatchObject({ status: 'key_missing' });

    await configureGitHubApp({ ...github, pkcs8Pem: (await generateAppKey()).pkcs8Pem });

    await expect(getStatus()).resolves.toMatchObject({ status: 'key_rejected' });
  });

  test('reports a missing, removed or suspended installation', async () => {
    await configureGitHubApp(github);
    await db.run(`DELETE FROM setting WHERE key = 'github_installation'`);

    await expect(getStatus()).resolves.toMatchObject({
      status: 'not_installed',
      installation: null,
    });

    // The repository was removed from the installation
    await configureGitHubApp(github);
    github.state.repositories = [];

    await expect(getStatus()).resolves.toMatchObject({ status: 'not_installed' });

    github.state.installationId = 999;

    await expect(getStatus()).resolves.toMatchObject({ status: 'not_installed' });

    github.state.installationId = 202;
    github.state.repositories = ['site'];
    github.state.suspended = true;

    await expect(getStatus()).resolves.toMatchObject({ status: 'suspended' });
  });

  test('reports GitHub as unreachable, and skips a branch check that failed', async () => {
    await configureGitHubApp(github);

    const realFetch = vi.mocked(globalThis.fetch).getMockImplementation();

    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const { pathname } = new URL(new Request(input, init).url);

      if (pathname.startsWith('/repos/')) {
        return Response.json({ message: 'Server Error' }, { status: 500 });
      }

      return /** @type {any} */ (realFetch)(input, init);
    });

    await expect(getStatus()).resolves.toMatchObject({ status: 'ok', default_branch: null });

    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('Network error'));

    await expect(getStatus()).resolves.toMatchObject({ status: 'unreachable' });

    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const { pathname } = new URL(new Request(input, init).url);

      return pathname.startsWith('/app/installations/')
        ? Response.json({ message: 'Server Error' }, { status: 500 })
        : /** @type {any} */ (realFetch)(input, init);
    });

    await expect(getStatus()).resolves.toMatchObject({ status: 'unreachable' });
  });
});
