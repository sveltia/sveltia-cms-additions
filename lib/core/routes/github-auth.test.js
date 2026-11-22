import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { installFakeGitHub } from '../../test/fake-github.js';
import {
  ADMIN_SECRET,
  configureGitHubApp,
  createPrehash,
  db,
  request,
  requestJson,
  resetState,
  signIn,
} from '../../test/helpers.js';
import { toBase64Url, toUtf8 } from '../crypto/encoding.js';

const ORIGIN = 'https://cms.example';
const REDIRECT_URI = `${ORIGIN}/admin/`;

/** @type {Awaited<ReturnType<typeof installFakeGitHub>>} */
let github;
/** @type {string} */
let adminToken;
/** @type {string} */
let adminPrehash;

/**
 * Send an admin request.
 * @param {string} method Method.
 * @param {string} path Path.
 * @param {Record<string, any>} [body] Body.
 * @returns {Promise<Response>} Response.
 */
const asAdmin = (method, path, body) =>
  requestJson(method, path, { body, token: adminToken, origin: ORIGIN });

/**
 * Sign in with GitHub like the CMS’s auth popup: start with a PKCE challenge, let GitHub send the
 * browser back, and return where the service sends it on to.
 * @param {string} login GitHub user who authorizes the app.
 * @param {Record<string, string>} [extra] Extra query parameters, e.g. `link`.
 * @param {() => Promise<void>} [whileOnGitHub] Something that happens while the user is on GitHub.
 * @returns {Promise<{ location: URL, verifier: string }>} Final redirect and the PKCE verifier.
 */
const authorize = async (login, extra = {}, whileOnGitHub = undefined) => {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = toBase64Url(await crypto.subtle.digest('SHA-256', toUtf8(verifier)));

  const start = await request(
    `/v1/auth/start/github?${new URLSearchParams({
      redirect_uri: REDIRECT_URI,
      state: 'cms-state',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...extra,
    })}`,
    { redirect: 'manual' },
  );

  const authorizeUrl = new URL(/** @type {string} */ (start.headers.get('location')));

  expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
    'https://github.com/login/oauth/authorize',
  );
  expect(authorizeUrl.searchParams.get('client_id')).toBe('Iv1.client');

  github.state.oauthCodes.set('gh-code', login);
  await whileOnGitHub?.();

  const callback = await request(
    `/v1/auth/callback/github?code=gh-code&state=${authorizeUrl.searchParams.get('state')}`,
    { redirect: 'manual' },
  );

  return { location: new URL(/** @type {string} */ (callback.headers.get('location'))), verifier };
};

/**
 * Sign in with GitHub all the way, exchanging the code for a session.
 * @param {string} login GitHub user.
 * @returns {Promise<any>} Token response.
 */
const signInWithGitHub = async (login) => {
  const { location, verifier } = await authorize(login);

  expect(location.searchParams.get('state')).toBe('cms-state');

  const response = await requestJson('POST', '/v1/auth/token', {
    body: {
      grant_type: 'authorization_code',
      code: location.searchParams.get('code'),
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
    },
  });

  return response.json();
};

/**
 * Get the users as the admin sees them.
 * @returns {Promise<any[]>} Users.
 */
const listUsers = async () => (await (await asAdmin('GET', '/v1/users')).json()).users;

/**
 * Sign out a user of their own, which runs the revocation of the pending tokens.
 * @returns {Promise<void>}
 */
const signOutSomeoneElse = async () => {
  const { user } = await (
    await asAdmin('POST', '/v1/users', {
      username: `other-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Other',
      role: 'editor',
      prehash: createPrehash(),
    })
  ).json();

  await asAdmin('DELETE', `/v1/users/${user.id}/sessions`);
};

beforeEach(async () => {
  await resetState();
  github = await installFakeGitHub();

  adminPrehash = createPrehash();

  await requestJson('POST', '/v1/setup/admin', {
    body: { username: 'admin', prehash: adminPrehash, allow_origin: true },
    token: ADMIN_SECRET,
    origin: ORIGIN,
  });
  adminToken = await signIn('admin', adminPrehash);
  await configureGitHubApp(github);
  await asAdmin('PATCH', '/v1/settings', { sign_in_methods: { github: true } });
});

afterEach(() => {
  github.restore();
});

describe('sign-in with GitHub', () => {
  test('signs in someone an admin named by GitHub username, with their own token', async () => {
    const created = await asAdmin('POST', '/v1/users', {
      username: 'mona',
      name: 'Mona',
      role: 'editor',
      github: 'OctoCat',
    });

    expect(created.status).toBe(201);
    expect((await listUsers()).find(({ username }) => username === 'mona')).toMatchObject({
      sign_in_methods: ['github'],
      github: { login: 'octocat', waiting_for_sign_in: true },
      must_change_password: false,
    });

    const result = await signInWithGitHub('octocat');

    expect(result).toMatchObject({
      access_token: expect.stringMatching(/^ghu_/),
      refresh_token: expect.stringMatching(/\./),
      user: { username: 'mona', role: 'editor' },
      // Commits are the person’s own, so there is no commit author to set
      git: { kind: 'user', provider: 'github', repository: 'sveltia/site' },
    });
    expect(result.git.commit_author).toBeUndefined();

    // The session works like any other, and keeps the same GitHub token
    const session = await (
      await requestJson('GET', '/v1/auth/session', { token: result.refresh_token })
    ).json();

    expect(session.git.token).toBe(result.access_token);
    // With no password to change
    expect(session.user.has_password).toBe(false);
    expect((await listUsers()).find(({ username }) => username === 'mona')).toMatchObject({
      github: { waiting_for_sign_in: false },
    });

    const { version } = await (await request('/version')).json().then((info) => ({
      version: info.sign_in_methods,
    }));

    expect(version).toEqual(['password', 'github']);
  });

  test('replaces a temporary password with the GitHub sign-in', async () => {
    const temporary = createPrehash();

    await asAdmin('POST', '/v1/users', {
      username: 'mona',
      name: 'Mona',
      role: 'editor',
      prehash: temporary,
      github: 'octocat',
    });

    await expect(signInWithGitHub('octocat')).resolves.toMatchObject({
      user: { username: 'mona', must_change_password: false },
      git: { kind: 'user' },
    });
    // The temporary password no longer works
    await expect(signIn('mona', temporary)).rejects.toThrow();
    expect((await listUsers()).find(({ username }) => username === 'mona')).toMatchObject({
      sign_in_methods: ['github'],
    });
  });

  test('turns away someone nobody invited, or who refuses', async () => {
    const { location } = await authorize('hubot');

    expect(location.toString()).toBe(`${REDIRECT_URI}?error=not_invited&state=cms-state`);

    // GitHub sends the browser back without a code when the user cancels
    const start = await request(
      `/v1/auth/start/github?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s&` +
        `code_challenge=${'a'.repeat(43)}`,
      { redirect: 'manual' },
    );
    const state = new URL(/** @type {string} */ (start.headers.get('location'))).searchParams.get(
      'state',
    );
    const denied = await request(`/v1/auth/callback/github?error=access_denied&state=${state}`, {
      redirect: 'manual',
    });

    expect(denied.headers.get('location')).toBe(`${REDIRECT_URI}?error=access_denied&state=s`);
  });

  test('creates an account for an organization member, and disables it once they leave', async () => {
    // A rule can’t give the admin role, or name an organization the app isn’t installed on
    expect(
      (
        await asAdmin('PATCH', '/v1/settings', {
          sign_up_rules: [{ type: 'github_org', org: 'sveltia', role: 'admin' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await asAdmin('PATCH', '/v1/settings', {
          sign_up_rules: [{ type: 'github_org', org: 'elsewhere', role: 'viewer' }],
        })
      ).status,
    ).toBe(400);

    const { sign_up_rules: rules } = await (
      await asAdmin('PATCH', '/v1/settings', {
        sign_up_rules: [{ type: 'github_org', org: 'Sveltia', role: 'viewer' }],
      })
    ).json();

    expect(rules).toEqual([
      { id: expect.any(String), type: 'github_org', org: 'sveltia', role: 'viewer' },
    ]);

    github.state.users.set('octocat', {
      id: 501,
      login: 'octocat',
      name: `Mona ${'Octocat'.repeat(20)}`,
    });

    await expect(signInWithGitHub('octocat')).resolves.toMatchObject({
      user: { username: 'octocat', name: expect.stringMatching(/^Mona Octocat/), role: 'viewer' },
    });
    expect((await listUsers()).find(({ username }) => username === 'octocat').name).toHaveLength(
      100,
    );
    expect((await listUsers()).find(({ username }) => username === 'octocat')).toMatchObject({
      sign_up_rule: rules[0].id,
    });

    // The membership is checked at every sign-in
    github.state.orgMembers.delete('octocat');

    const { location } = await authorize('octocat');

    expect(location.searchParams.get('error')).toBe('not_invited');
    expect((await listUsers()).find(({ username }) => username === 'octocat')).toMatchObject({
      disabled: true,
    });
  });

  test('checks a member again while they keep using their session, at most every hour', async () => {
    await asAdmin('PATCH', '/v1/settings', {
      sign_up_rules: [{ type: 'github_org', org: 'sveltia', role: 'editor' }],
    });

    const { refresh_token: session } = await signInWithGitHub('octocat');
    const user = (await listUsers()).find(({ username }) => username === 'octocat');

    // Left the organization, but checked less than an hour ago
    github.state.orgMembers.delete('octocat');
    expect((await requestJson('GET', '/v1/auth/session', { token: session })).status).toBe(200);

    // An hour later
    await db.run('UPDATE rule_member SET checked_at = ? WHERE user_id = ?', [
      Date.now() - 61 * 60 * 1000,
      user.id,
    ]);

    const response = await requestJson('POST', '/v1/auth/token', {
      body: { grant_type: 'refresh_token', refresh_token: session },
    });

    expect(response.status).toBe(403);
    expect((await listUsers()).find(({ id }) => id === user.id)).toMatchObject({ disabled: true });
  });

  test('stops checking a member once they’re promoted to admin', async () => {
    await asAdmin('PATCH', '/v1/settings', {
      sign_up_rules: [{ type: 'github_org', org: 'sveltia', role: 'editor' }],
    });
    await signInWithGitHub('octocat');

    const user = (await listUsers()).find(({ username }) => username === 'octocat');

    await asAdmin('PATCH', `/v1/users/${user.id}`, { role: 'admin' });
    github.state.orgMembers.delete('octocat');

    await expect(signInWithGitHub('octocat')).resolves.toMatchObject({
      user: { username: 'octocat', role: 'admin' },
    });
    expect((await listUsers()).find(({ id }) => id === user.id)).toMatchObject({
      disabled: false,
      sign_up_rule: null,
    });
  });

  test('keeps a member’s account when the organization can’t be found, e.g. after a rename', async () => {
    await asAdmin('PATCH', '/v1/settings', {
      sign_up_rules: [{ type: 'github_org', org: 'sveltia', role: 'editor' }],
    });
    await signInWithGitHub('octocat');

    // GitHub answers 404 for everyone once the organization is gone
    github.state.organizationMissing = true;
    github.state.orgMembers.delete('octocat');

    const { location } = await authorize('octocat');

    expect(location.searchParams.get('error')).toBe('github_error');
    expect((await listUsers()).find(({ username }) => username === 'octocat')).toMatchObject({
      disabled: false,
    });
  });

  test('keeps a member’s account while GitHub can’t check the organization', async () => {
    await asAdmin('PATCH', '/v1/settings', {
      sign_up_rules: [{ type: 'github_org', org: 'sveltia', role: 'editor' }],
    });
    await signInWithGitHub('octocat');
    github.state.membershipFails = true;

    const { location } = await authorize('octocat');

    expect(location.searchParams.get('error')).toBe('github_error');
    expect((await listUsers()).find(({ username }) => username === 'octocat')).toMatchObject({
      disabled: false,
    });

    // Nor is a new member let in or turned away for good
    github.state.users.set('hubot', { id: 502, login: 'hubot', name: null });
    github.state.orgMembers.add('hubot');

    const { location: newcomer } = await authorize('hubot');

    expect(newcomer.searchParams.get('error')).toBe('github_error');
  });

  test('signs out whoever used a GitHub account an admin replaces or removes', async () => {
    const { user } = await (
      await asAdmin('POST', '/v1/users', {
        username: 'mona',
        name: 'Mona',
        role: 'editor',
        github: 'octocat',
      })
    ).json();
    const { refresh_token: sessionToken } = await signInWithGitHub('octocat');

    // Another user can’t be given the account, and nothing else in the change is made
    const { user: other } = await (
      await asAdmin('POST', '/v1/users', {
        username: 'other',
        name: 'Other',
        role: 'editor',
        prehash: createPrehash(),
      })
    ).json();
    const taken = await asAdmin('PATCH', `/v1/users/${other.id}`, {
      name: 'Renamed',
      github: 'octocat',
    });

    expect(taken.status).toBe(409);
    expect((await listUsers()).find(({ id }) => id === other.id).name).toBe('Other');

    await asAdmin('PATCH', `/v1/users/${user.id}`, { github: 'hubot' });
    expect((await requestJson('GET', '/v1/auth/session', { token: sessionToken })).status).toBe(
      401,
    );
  });

  test('drops the refresh token of a grant that couldn’t be revoked, unless signed in again since', async () => {
    const { user } = await (
      await asAdmin('POST', '/v1/users', {
        username: 'mona',
        name: 'Mona',
        role: 'editor',
        github: 'octocat',
      })
    ).json();

    const { user: other } = await (
      await asAdmin('POST', '/v1/users', {
        username: 'other',
        name: 'Other',
        role: 'editor',
        prehash: createPrehash(),
      })
    ).json();

    /**
     * Mark the user’s current token as waiting to be revoked, as if GitHub had been down, and
     * expired since.
     * @returns {Promise<any>} Result.
     */
    const strand = () =>
      db.run(
        "UPDATE issued_token SET revoke_requested_at = ?, expires_at = ? WHERE kind = 'user' " +
          'AND revoke_requested_at IS NULL',
        [Date.now(), Date.now() - 1000],
      );

    /**
     * Run the revocation of pending tokens, which signing someone else out does.
     * @returns {Promise<Response>} Response.
     */
    const revokePending = () => asAdmin('DELETE', `/v1/users/${other.id}/sessions`);

    /**
     * Check whether the user has a refresh token.
     * @returns {Promise<boolean>} Result.
     */
    const hasRefreshToken = async () =>
      !!(
        await db.first(
          "SELECT refresh_token_ciphertext FROM provider_account WHERE provider = 'github' AND user_id = ?",
          [user.id],
        )
      ).refresh_token_ciphertext;

    await signInWithGitHub('octocat');
    await strand();
    // Signed in again since, which stored a new refresh token
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    await signInWithGitHub('octocat');
    await revokePending();
    expect(await hasRefreshToken()).toBe(true);

    await strand();
    await revokePending();
    expect(await hasRefreshToken()).toBe(false);
  });

  test('stops handing out a newer token once a late grant revocation has taken it', async () => {
    const { user } = await (
      await asAdmin('POST', '/v1/users', {
        username: 'mona',
        name: 'Mona',
        role: 'editor',
        github: 'octocat',
      })
    ).json();

    await signInWithGitHub('octocat');

    // Signed out everywhere while GitHub fails to revoke the grant, then signs in again
    github.state.grantRevocationFails = true;
    await asAdmin('DELETE', `/v1/users/${user.id}/sessions`);

    const { refresh_token: session, access_token: second } = await signInWithGitHub('octocat');

    // The retry, run when someone else is signed out, revokes the grant, which takes the newer
    // token with it
    github.state.grantRevocationFails = false;
    await signOutSomeoneElse();

    const { git } = await (await requestJson('GET', '/v1/auth/session', { token: session })).json();

    expect(git.token).not.toBe(second);
    expect(git.kind).toBe('installation');
  });

  test('keeps an expired token waiting to be revoked until the revocation has dealt with it', async () => {
    const { user } = await (
      await asAdmin('POST', '/v1/users', {
        username: 'mona',
        name: 'Mona',
        role: 'editor',
        github: 'octocat',
      })
    ).json();

    await signInWithGitHub('octocat');

    // Waiting to be revoked, and expired since
    await db.run(
      "UPDATE issued_token SET revoke_requested_at = ?, expires_at = ? WHERE kind = 'user'",
      [Date.now(), Date.now() - 1000],
    );

    // Someone else gets a token, which drops the expired ones
    await asAdmin('GET', '/v1/auth/session');

    // The revocation, run when someone else is signed out, then finds the user’s grant can’t be
    // revoked any more, and drops the refresh token that would bring a token back
    await signOutSomeoneElse();

    await expect(
      db.first(
        "SELECT refresh_token_ciphertext FROM provider_account WHERE provider = 'github' AND user_id = ?",
        [user.id],
      ),
    ).resolves.toEqual({ refresh_token_ciphertext: null });
  });

  test('stops checking a member an admin adopted', async () => {
    await asAdmin('PATCH', '/v1/settings', {
      sign_up_rules: [{ type: 'github_org', org: 'sveltia', role: 'editor' }],
    });
    await signInWithGitHub('octocat');

    const user = (await listUsers()).find(({ username }) => username === 'octocat');

    await asAdmin('PATCH', `/v1/users/${user.id}`, { adopted: true });
    github.state.orgMembers.delete('octocat');

    await expect(signInWithGitHub('octocat')).resolves.toMatchObject({
      user: { username: 'octocat' },
    });
  });

  test('stops a sign-in started before signing in with GitHub was turned off', async () => {
    await asAdmin('POST', '/v1/users', {
      username: 'mona',
      name: 'Mona',
      role: 'editor',
      github: 'octocat',
    });

    const { location } = await authorize('octocat', {}, async () => {
      await asAdmin('PATCH', '/v1/settings', { sign_in_methods: { github: false } });
    });

    expect(location.searchParams.get('error')).toBe('method_disabled');
  });

  test('forgets a link asked for before the password was changed', async () => {
    const { link } = await (await asAdmin('POST', '/v1/auth/link/github')).json();
    const changed = await asAdmin('POST', '/v1/auth/password', {
      current_prehash: adminPrehash,
      new_prehash: createPrehash(),
    });

    expect(changed.status).toBe(200);

    const start = await request(
      `/v1/auth/start/github?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s&` +
        `code_challenge=${'a'.repeat(43)}&link=${link}`,
      { redirect: 'manual' },
    );

    expect(start.status).toBe(400);
  });

  test('refuses a code for someone disabled since it was issued', async () => {
    const { user } = await (
      await asAdmin('POST', '/v1/users', {
        username: 'mona',
        name: 'Mona',
        role: 'editor',
        github: 'octocat',
      })
    ).json();
    const { location, verifier } = await authorize('octocat');

    await asAdmin('PATCH', `/v1/users/${user.id}`, { disabled: true });

    const response = await requestJson('POST', '/v1/auth/token', {
      body: {
        grant_type: 'authorization_code',
        code: location.searchParams.get('code'),
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      },
    });

    // Disabling the user forgot the code, so it can’t start a session
    expect(response.status).toBe(400);
  });

  test('tells someone who only signs in with GitHub they have no password to change', async () => {
    await asAdmin('POST', '/v1/users', {
      username: 'mona',
      name: 'Mona',
      role: 'editor',
      github: 'octocat',
    });

    const { refresh_token: session } = await signInWithGitHub('octocat');
    const response = await requestJson('POST', '/v1/auth/password', {
      body: { current_prehash: createPrehash(), new_prehash: createPrehash() },
      token: session,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'no_password' } });
  });

  test('forgets a link asked for before an admin reset the password', async () => {
    /**
     * Try to use a link reference.
     * @param {string} link Link reference.
     * @returns {Promise<number>} Status of the start of the flow.
     */
    const tryLink = async (link) =>
      (
        await request(
          `/v1/auth/start/github?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s&` +
            `code_challenge=${'a'.repeat(43)}&link=${link}`,
          { redirect: 'manual' },
        )
      ).status;

    // Another user’s link, then their password reset by the admin
    const temporary = createPrehash();
    const { user } = await (
      await asAdmin('POST', '/v1/users', {
        username: 'mona',
        name: 'Mona',
        role: 'editor',
        prehash: temporary,
      })
    ).json();
    const { session_token: monaToken } = await (
      await requestJson('POST', '/v1/auth/password', {
        body: { current_prehash: temporary, new_prehash: createPrehash() },
        token: await signIn('mona', temporary),
      })
    ).json();
    const { link: monaLink } = await (
      await requestJson('POST', '/v1/auth/link/github', { token: monaToken, origin: ORIGIN })
    ).json();

    expect(monaLink).toEqual(expect.any(String));

    await asAdmin('POST', `/v1/users/${user.id}/password`, { prehash: createPrehash() });
    expect(await tryLink(monaLink)).toBe(400);

    // The admin’s own link, then their password reset with the admin secret
    const { link: adminLink } = await (await asAdmin('POST', '/v1/auth/link/github')).json();

    expect(adminLink).toEqual(expect.any(String));
    await requestJson('POST', '/v1/setup/admin', {
      body: { username: 'admin', prehash: createPrehash() },
      token: ADMIN_SECRET,
      origin: ORIGIN,
    });
    expect(await tryLink(adminLink)).toBe(400);
  });

  test('stops handing out the token of the account a user replaces by linking another', async () => {
    /**
     * Link a GitHub account to the admin.
     * @param {string} login GitHub username.
     * @returns {Promise<any>} Token response.
     */
    const link = async (login) => {
      const { link: reference } = await (await asAdmin('POST', '/v1/auth/link/github')).json();
      const { location, verifier } = await authorize(login, { link: reference });

      return (
        await requestJson('POST', '/v1/auth/token', {
          body: {
            grant_type: 'authorization_code',
            code: location.searchParams.get('code'),
            code_verifier: verifier,
            redirect_uri: REDIRECT_URI,
          },
        })
      ).json();
    };

    const first = await link('octocat');

    expect(github.state.userTokens.get(first.access_token)).toBe('octocat');

    const second = await link('hubot');

    expect(github.state.userTokens.get(second.access_token)).toBe('hubot');
    expect(github.state.revokedGrants).toContain('octocat');
  });

  test('links a GitHub account to the signed-in user', async () => {
    const { link } = await (await asAdmin('POST', '/v1/auth/link/github')).json();
    const { location, verifier } = await authorize('octocat', { link });

    const result = await (
      await requestJson('POST', '/v1/auth/token', {
        body: {
          grant_type: 'authorization_code',
          code: location.searchParams.get('code'),
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
        },
      })
    ).json();

    expect(result).toMatchObject({ user: { username: 'admin' }, git: { kind: 'user' } });
    expect((await listUsers())[0]).toMatchObject({
      sign_in_methods: ['password', 'github'],
      github: { login: 'octocat' },
    });

    // The account can’t then be linked to someone else
    await asAdmin('POST', '/v1/users', {
      username: 'other',
      name: 'Other',
      role: 'editor',
      prehash: createPrehash(),
    });

    const taken = await asAdmin('POST', '/v1/users', {
      username: 'third',
      name: 'Third',
      role: 'editor',
      github: 'octocat',
    });

    expect(taken.status).toBe(409);
    expect((await listUsers()).map(({ username }) => username)).not.toContain('third');

    // A link reference only works once
    const reused = await request(
      `/v1/auth/start/github?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s&` +
        `code_challenge=${'a'.repeat(43)}&link=${link}`,
      { redirect: 'manual' },
    );

    expect(reused.status).toBe(400);
  });

  test('only links the account once the browser that asked for it exchanges the code', async () => {
    // Someone asks for a link to their own account, then gets someone else to authorize on GitHub
    // with it, e.g. by sending them the URL
    const { link } = await (await asAdmin('POST', '/v1/auth/link/github')).json();
    const { location } = await authorize('octocat', { link });

    // The victim’s browser has the code, but not the PKCE verifier, so nothing is linked
    expect(location.searchParams.get('code')).toBeTruthy();
    expect((await listUsers())[0]).toMatchObject({ sign_in_methods: ['password'], github: null });

    // Nor can the code be exchanged without the verifier
    const exchanged = await requestJson('POST', '/v1/auth/token', {
      body: {
        grant_type: 'authorization_code',
        code: location.searchParams.get('code'),
        code_verifier: 'wrong'.repeat(9),
        redirect_uri: REDIRECT_URI,
      },
    });

    expect(exchanged.status).toBe(400);
    expect((await listUsers())[0]).toMatchObject({ github: null });
  });

  test('refuses a link to an account someone has taken meanwhile', async () => {
    const { link } = await (await asAdmin('POST', '/v1/auth/link/github')).json();
    const { location, verifier } = await authorize('octocat', { link });

    // Someone else signs in with the account before the code is exchanged
    await asAdmin('POST', '/v1/users', {
      username: 'other',
      name: 'Other',
      role: 'editor',
      github: 'octocat',
    });

    const response = await requestJson('POST', '/v1/auth/token', {
      body: {
        grant_type: 'authorization_code',
        code: location.searchParams.get('code'),
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      },
    });

    expect(response.status).toBe(409);
    expect((await listUsers()).find(({ username }) => username === 'admin')).toMatchObject({
      github: null,
    });
  });

  test('refreshes the token one at a time, and falls back to an installation token', async () => {
    await asAdmin('POST', '/v1/users', {
      username: 'mona',
      name: 'Mona',
      role: 'editor',
      github: 'octocat',
    });

    const { refresh_token: sessionToken, access_token: first } = await signInWithGitHub('octocat');

    // The token is about to expire
    await db.run("UPDATE issued_token SET expires_at = ? WHERE kind = 'user'", [
      Date.now() + 60 * 1000,
    ]);

    const [a, b] = await Promise.all(
      [1, 2].map(async () =>
        (await requestJson('GET', '/v1/auth/session', { token: sessionToken })).json(),
      ),
    );

    expect(a.git.token).not.toBe(first);
    expect(a.git.token).toBe(b.git.token);

    // GitHub is down: the user carries on with an installation token for now, and the refresh
    // token is kept for later
    await db.run("UPDATE issued_token SET expires_at = ? WHERE kind = 'user'", [
      Date.now() + 60 * 1000,
    ]);
    github.state.tokenEndpointDown = true;

    await expect(
      (await requestJson('GET', '/v1/auth/session', { token: sessionToken })).json(),
    ).resolves.toMatchObject({ git: { kind: 'installation' } });
    github.state.tokenEndpointDown = false;
    await expect(
      (await requestJson('GET', '/v1/auth/session', { token: sessionToken })).json(),
    ).resolves.toMatchObject({ git: { kind: 'user' } });

    // The refresh token is spent or revoked: the user carries on with an installation token
    await db.run("UPDATE issued_token SET expires_at = ? WHERE kind = 'user'", [
      Date.now() + 60 * 1000,
    ]);
    github.state.refreshFails = true;

    const after = await (
      await requestJson('GET', '/v1/auth/session', { token: sessionToken })
    ).json();

    expect(after.git).toMatchObject({ kind: 'installation', commit_author: { mode: 'user' } });
  });

  test('keeps the user’s own token through a role change', async () => {
    await asAdmin('POST', '/v1/users', {
      username: 'mona',
      name: 'Mona',
      role: 'editor',
      github: 'octocat',
    });

    const { refresh_token: sessionToken, access_token: token } = await signInWithGitHub('octocat');
    const user = (await listUsers()).find(({ username }) => username === 'mona');

    await asAdmin('PATCH', `/v1/users/${user.id}`, { role: 'viewer' });

    expect(github.state.revokedGrants).toEqual([]);
    await expect(
      (await requestJson('GET', '/v1/auth/session', { token: sessionToken })).json(),
    ).resolves.toMatchObject({ user: { role: 'viewer' }, git: { kind: 'user', token } });
  });

  test('revokes the user’s authorization of the app when they’re disabled', async () => {
    await asAdmin('POST', '/v1/users', {
      username: 'mona',
      name: 'Mona',
      role: 'editor',
      github: 'octocat',
    });
    await signInWithGitHub('octocat');

    const user = (await listUsers()).find(({ username }) => username === 'mona');

    await asAdmin('PATCH', `/v1/users/${user.id}`, { disabled: true });

    expect(github.state.revokedGrants).toEqual(['octocat']);
    expect(
      await db.first(
        "SELECT refresh_token_ciphertext FROM provider_account WHERE provider = 'github' AND user_id = ?",
        [user.id],
      ),
    ).toEqual({ refresh_token_ciphertext: null });

    // Forgetting the account
    await asAdmin('PATCH', `/v1/users/${user.id}`, { github: null });
    expect((await listUsers()).find(({ username }) => username === 'mona').github).toBeNull();
  });
});

describe('sign-in with GitHub guards', () => {
  test('needs the method turned on, an allowed page and a PKCE challenge', async () => {
    const start = (/** @type {Record<string, string>} */ params) =>
      request(`/v1/auth/start/github?${new URLSearchParams(params)}`, { redirect: 'manual' });

    const valid = { redirect_uri: REDIRECT_URI, state: 's', code_challenge: 'a'.repeat(43) };

    expect((await start({ ...valid, redirect_uri: 'https://evil.example/' })).status).toBe(400);
    expect((await start({ ...valid, code_challenge: 'short' })).status).toBe(400);
    expect((await start({ ...valid, code_challenge_method: 'plain' })).status).toBe(400);
    expect((await start({ ...valid, state: '' })).status).toBe(400);
    expect((await start({ ...valid, link: 'nope' })).status).toBe(400);

    await asAdmin('PATCH', '/v1/settings', { sign_in_methods: { github: false } });
    expect((await start(valid)).status).toBe(403);
    expect((await asAdmin('POST', '/v1/auth/link/github')).status).toBe(403);
    expect(
      (await asAdmin('PATCH', '/v1/settings', { sign_in_methods: { github: 1 } })).status,
    ).toBe(400);
  });

  test('limit how often a client starts a sign-in', async () => {
    const path =
      `/v1/auth/start/github?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s&` +
      `code_challenge=${'a'.repeat(43)}`;

    const statuses = await Array.from({ length: 31 }).reduce(
      async (previous) => [
        ...(await previous),
        (await request(path, { redirect: 'manual', headers: { 'CF-Connecting-IP': '192.0.2.9' } }))
          .status,
      ],
      Promise.resolve(/** @type {number[]} */ ([])),
    );

    expect(statuses.at(-2)).toBe(302);
    expect(statuses.at(-1)).toBe(429);
  });

  test('refuse an unknown state, a bad GitHub code and a misused code', async () => {
    expect((await request('/v1/auth/callback/github?code=x&state=nope')).status).toBe(400);

    await asAdmin('POST', '/v1/users', {
      username: 'mona',
      name: 'Mona',
      role: 'editor',
      github: 'octocat',
    });

    const { location, verifier } = await authorize('octocat');
    const code = /** @type {string} */ (location.searchParams.get('code'));

    /**
     * Exchange the code.
     * @param {Record<string, any>} body Body.
     * @returns {Promise<number>} Status.
     */
    const exchange = async (body) =>
      (
        await requestJson('POST', '/v1/auth/token', {
          body: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, ...body },
        })
      ).status;

    // A wrong verifier uses the code up
    expect(await exchange({ code_verifier: 'wrong' })).toBe(400);
    expect(await exchange({ code_verifier: verifier })).toBe(400);
    expect(await exchange({ code: 1, code_verifier: verifier })).toBe(400);
    expect(
      (await requestJson('POST', '/v1/auth/token', { body: { grant_type: 'password' } })).status,
    ).toBe(400);

    // GitHub refuses the code it sent
    const start = await request(
      `/v1/auth/start/github?redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s&` +
        `code_challenge=${'a'.repeat(43)}`,
      { redirect: 'manual' },
    );
    const state = new URL(/** @type {string} */ (start.headers.get('location'))).searchParams.get(
      'state',
    );
    const refused = await request(`/v1/auth/callback/github?code=forged&state=${state}`, {
      redirect: 'manual',
    });

    expect(refused.headers.get('location')).toBe(`${REDIRECT_URI}?error=github_error&state=s`);
  });

  test('check the GitHub username an admin enters', async () => {
    /**
     * Create a user.
     * @param {Record<string, any>} body Body.
     * @returns {Promise<number>} Status.
     */
    const create = async (body) =>
      (
        await asAdmin('POST', '/v1/users', {
          username: 'x-user',
          name: 'X',
          role: 'viewer',
          ...body,
        })
      ).status;

    expect(await create({})).toBe(400);
    expect(await create({ github: 'not a name' })).toBe(400);
    expect(await create({ github: 'nobody-here' })).toBe(400);
  });
});
