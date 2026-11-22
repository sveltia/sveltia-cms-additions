import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { installFakeGitHub } from '../test/fake-github.js';
import {
  configureGitHubApp,
  createAdmin,
  createPrehash,
  db,
  getDefaultTenantObject,
  requestJson,
  resetState,
  signIn,
} from '../test/helpers.js';

/** @type {Awaited<ReturnType<typeof installFakeGitHub>>} */
let github;
/** @type {string} */
let adminToken;

/**
 * Create a user who has changed their temporary password, and sign them in.
 * @param {string} role Role.
 * @returns {Promise<{ id: string, token: string, prehash: string }>} User ID, session token and
 * prehash of the password.
 */
const createSignedInUser = async (role) => {
  const temporary = createPrehash();
  const { user } = await (
    await requestJson('POST', '/v1/users', {
      body: { username: role, name: role, role, prehash: temporary },
      token: adminToken,
    })
  ).json();
  const signedIn = await signIn(role, temporary);
  const prehash = createPrehash();
  const changed = await requestJson('POST', '/v1/auth/password', {
    body: { current_prehash: temporary, new_prehash: prehash },
    token: signedIn,
  });

  return { id: user.id, token: (await changed.json()).session_token, prehash };
};

/**
 * Get the session, with its GitHub token.
 * @param {string} token Session token.
 * @returns {Promise<any>} Session.
 */
const getSession = async (token) =>
  (await requestJson('GET', '/v1/auth/session', { token })).json();

beforeEach(async () => {
  await resetState();
  github = await installFakeGitHub();

  const admin = await createAdmin();

  adminToken = await signIn('admin', admin.prehash);
});

afterEach(() => {
  github.restore();
});

describe('GET /v1/auth/session', () => {
  test('has no GitHub token until the GitHub App is set up', async () => {
    await expect(getSession(adminToken)).resolves.toMatchObject({ git: null });
  });

  test('gives a viewer a read-only token for the site’s repository', async () => {
    await configureGitHubApp(github);

    const viewer = await createSignedInUser('viewer');
    const { git } = await getSession(viewer.token);

    expect(git).toMatchObject({
      kind: 'installation',
      provider: 'github',
      repository: 'sveltia/site',
      permissions: { contents: 'read', metadata: 'read', pull_requests: 'read', statuses: 'read' },
    });
    expect(github.state.tokens.get(git.token)).toMatchObject({ repository: 'site' });
    expect(new Date(git.expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
  });

  test('gives an editor a token that can write', async () => {
    await configureGitHubApp(github);

    const editor = await createSignedInUser('editor');
    const { git } = await getSession(editor.token);

    expect(git.permissions).toMatchObject({ contents: 'write', pull_requests: 'write' });
  });

  test('keeps working after the repository is renamed, and learns its new name', async () => {
    await configureGitHubApp(github);
    github.state.repositories = ['website'];

    const editor = await createSignedInUser('editor');
    const { git } = await getSession(editor.token);

    // Asked for by its ID, which doesn’t change
    expect(git.repository).toBe('sveltia/website');
    expect(github.state.tokens.get(git.token)?.repository).toBe('website');
    await expect(
      db.first("SELECT value FROM setting WHERE key = 'github_installation'"),
    ).resolves.toMatchObject({ value: expect.stringContaining('"name":"website"') });
  });

  test('reuses a token while it has time left, and stores it encrypted', async () => {
    await configureGitHubApp(github);

    const first = (await getSession(adminToken)).git;
    const second = (await getSession(adminToken)).git;

    expect(second.token).toBe(first.token);
    expect(github.state.tokens.size).toBe(1);

    const [row] = await db.all('SELECT token_ciphertext FROM issued_token');

    expect(row.token_ciphertext).not.toContain(first.token);
  });

  test('gives no token while the password must be changed', async () => {
    await configureGitHubApp(github);

    const temporary = createPrehash();

    await requestJson('POST', '/v1/users', {
      body: { username: 'editor', name: 'Editor', role: 'editor', prehash: temporary },
      token: adminToken,
    });

    const token = await signIn('editor', temporary);

    await expect(getSession(token)).resolves.toMatchObject({ git: null });
  });
});

describe('revocation', () => {
  test('covers a token minted while the user was being disabled', async () => {
    await configureGitHubApp(github);

    const editor = await createSignedInUser('editor');

    // The admin disables the editor while GitHub is minting the editor’s token
    github.state.whileMinting = async () => {
      await requestJson('PATCH', `/v1/users/${editor.id}`, {
        body: { disabled: true },
        token: adminToken,
      });
    };

    const response = await requestJson('GET', '/v1/auth/session', { token: editor.token });

    expect(response.status).toBe(401);

    // Whatever was minted for the editor is revoked
    const minted = [...github.state.tokens.keys()].filter(
      (token) => github.state.tokens.get(token)?.permissions?.contents === 'write',
    );

    expect(minted.length).toBeGreaterThan(0);
    minted.forEach((token) => expect(github.state.revoked.has(token)).toBe(true));
  });

  test('happens at once when an editor becomes a viewer, and the next token is read-only', async () => {
    await configureGitHubApp(github);

    const editor = await createSignedInUser('editor');
    const before = (await getSession(editor.token)).git;

    await requestJson('PATCH', `/v1/users/${editor.id}`, {
      body: { role: 'viewer' },
      token: adminToken,
    });

    expect(github.state.revoked.has(before.token)).toBe(true);

    const after = (await getSession(editor.token)).git;

    expect(after.token).not.toBe(before.token);
    expect(after.permissions.contents).toBe('read');
  });

  test('happens when a user is disabled, deleted, signed out or given a new password', async () => {
    await configureGitHubApp(github);

    const actions = [
      (/** @type {string} */ id) =>
        requestJson('PATCH', `/v1/users/${id}`, { body: { disabled: true }, token: adminToken }),
      (/** @type {string} */ id) => requestJson('DELETE', `/v1/users/${id}`, { token: adminToken }),
      (/** @type {string} */ id) =>
        requestJson('DELETE', `/v1/users/${id}/sessions`, { token: adminToken }),
      (/** @type {string} */ id) =>
        requestJson('POST', `/v1/users/${id}/password`, {
          body: { prehash: createPrehash() },
          token: adminToken,
        }),
    ];

    const revoked = await actions.reduce(
      async (previous, action, index) => {
        const list = await previous;
        const role = index % 2 ? 'editor' : 'viewer';
        const user = await createSignedInUser(role);
        const { git } = await getSession(user.token);

        await action(user.id);

        if (index !== 1) {
          await requestJson('DELETE', `/v1/users/${user.id}`, { token: adminToken });
        }

        return [...list, github.state.revoked.has(git.token)];
      },
      Promise.resolve(/** @type {boolean[]} */ ([])),
    );

    expect(revoked).toEqual([true, true, true, true]);
  });

  test('covers only the session that signs out', async () => {
    await configureGitHubApp(github);

    const editor = await createSignedInUser('editor');
    const otherToken = await signIn('editor', editor.prehash);
    const { git } = await getSession(editor.token);
    const { git: otherGit } = await getSession(otherToken);

    expect(otherGit.token).not.toBe(git.token);

    await requestJson('POST', '/v1/auth/sign-out', { token: editor.token });

    expect(github.state.revoked.has(git.token)).toBe(true);
    expect(github.state.revoked.has(otherGit.token)).toBe(false);
  });

  test('keeps a token waiting to be revoked from being handed out again', async () => {
    await configureGitHubApp(github);

    const editor = await createSignedInUser('editor');
    const { git } = await getSession(editor.token);

    // GitHub can’t revoke it now, and the user gets their role back before it can
    github.state.revocationFails = true;

    await requestJson('PATCH', `/v1/users/${editor.id}`, {
      body: { role: 'viewer' },
      token: adminToken,
    });
    await requestJson('PATCH', `/v1/users/${editor.id}`, {
      body: { role: 'editor' },
      token: adminToken,
    });

    expect((await getSession(editor.token)).git.token).not.toBe(git.token);
  });

  test('is retried in the background while GitHub fails', async () => {
    await configureGitHubApp(github);

    const editor = await createSignedInUser('editor');
    const { git } = await getSession(editor.token);

    github.state.revocationFails = true;

    await requestJson('PATCH', `/v1/users/${editor.id}`, {
      body: { disabled: true },
      token: adminToken,
    });

    const { users } = await (await requestJson('GET', '/v1/users', { token: adminToken })).json();

    expect(users.find(({ id }) => id === editor.id).pending_token_revocations).toBe(1);
    expect(github.state.revoked.has(git.token)).toBe(false);

    github.state.revocationFails = false;

    // A retry is due in a minute, on the alarm the tenant’s background jobs share
    const job = await db.first("SELECT due_at FROM scheduled_job WHERE name = 'token_revocation'");

    expect(job.due_at).toBeGreaterThan(Date.now());
    await expect(
      runInDurableObject(getDefaultTenantObject(), (_instance, state) => state.storage.getAlarm()),
    ).resolves.toBeLessThanOrEqual(job.due_at);
    await db.run("UPDATE scheduled_job SET due_at = ? WHERE name = 'token_revocation'", [
      Date.now(),
    ]);
    await expect(runDurableObjectAlarm(getDefaultTenantObject())).resolves.toBe(true);
    expect(github.state.revoked.has(git.token)).toBe(true);

    const after = await (await requestJson('GET', '/v1/users', { token: adminToken })).json();

    expect(after.users.find(({ id }) => id === editor.id).pending_token_revocations).toBe(0);
  });
});

describe('POST /v1/auth/token', () => {
  /**
   * Request a GitHub token with a session token, as the CMS does on a 401.
   * @param {Record<string, any>} body Body.
   * @returns {Promise<Response>} Response.
   */
  const refresh = (body) => requestJson('POST', '/v1/auth/token', { body });

  test('exchanges a session token for a GitHub token, like an OAuth refresh', async () => {
    await configureGitHubApp(github);

    const editor = await createSignedInUser('editor');
    const response = await refresh({ grant_type: 'refresh_token', refresh_token: editor.token });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      refresh_token: editor.token,
      token_type: 'bearer',
      user: { username: 'editor', role: 'editor' },
    });
    expect(github.state.tokens.has(body.access_token)).toBe(true);
    expect(body.expires_in).toBeGreaterThan(50 * 60);
  });

  test('gives a new token once the previous one was revoked', async () => {
    await configureGitHubApp(github);

    const editor = await createSignedInUser('editor');
    const first = (await getSession(editor.token)).git.token;

    await requestJson('PATCH', `/v1/users/${editor.id}`, {
      body: { role: 'viewer' },
      token: adminToken,
    });

    const body = await (
      await refresh({ grant_type: 'refresh_token', refresh_token: editor.token })
    ).json();

    expect(body.access_token).not.toBe(first);
    expect(body.user.role).toBe('viewer');
    expect(body.git.permissions.contents).toBe('read');
  });

  test('refuses an invalid session, another grant or a missing app', async () => {
    const invalid = await refresh({ grant_type: 'refresh_token', refresh_token: 'nope.nope' });
    const grant = await refresh({ grant_type: 'authorization_code', code: 'x' });
    const noApp = await refresh({ grant_type: 'refresh_token', refresh_token: adminToken });

    expect(invalid.status).toBe(401);
    expect(grant.status).toBe(400);
    expect(noApp.status).toBe(409);
  });
});
