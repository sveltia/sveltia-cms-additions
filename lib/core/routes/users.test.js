import { beforeEach, describe, expect, test } from 'vitest';

import { createAdmin, createPrehash, requestJson, resetState, signIn } from '../../test/helpers.js';

/** @type {string} */
let adminToken;
/** @type {any} */
let admin;

/**
 * Create a user as the admin, and return them with their temporary password.
 * @param {Record<string, any>} [fields] Fields to override.
 * @returns {Promise<{ user: any, prehash: string }>} User and prehash.
 */
const createUser = async (fields = {}) => {
  const prehash = createPrehash();
  const response = await requestJson('POST', '/v1/users', {
    body: { username: 'editor', name: 'Editor', role: 'editor', prehash, ...fields },
    token: adminToken,
  });

  return { user: (await response.json()).user, prehash };
};

/**
 * Sign in as a user who must change their temporary password, change it, and return a session.
 * @param {string} username Username.
 * @param {string} prehash Temporary password.
 * @returns {Promise<string>} Session token.
 */
const signInWithNewPassword = async (username, prehash) => {
  const token = await signIn(username, prehash);
  const response = await requestJson('POST', '/v1/auth/password', {
    body: { current_prehash: prehash, new_prehash: createPrehash() },
    token,
  });

  return (await response.json()).session_token;
};

beforeEach(async () => {
  await resetState();

  const created = await createAdmin();

  admin = created.user;
  adminToken = await signIn('admin', created.prehash);
});

describe('access', () => {
  test('requires an admin', async () => {
    const { prehash } = await createUser();
    const editorToken = await signInWithNewPassword('editor', prehash);
    const response = await requestJson('GET', '/v1/users', { token: editorToken });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'forbidden' } });
  });

  test('requires a changed temporary password, even for an admin', async () => {
    const { prehash } = await createUser({ username: 'second', role: 'admin' });
    const token = await signIn('second', prehash);
    const response = await requestJson('GET', '/v1/users', { token });

    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'password_change_required' },
    });
  });
});

describe('POST /v1/users', () => {
  test('creates a user who must change the password', async () => {
    const { user } = await createUser({ email: 'Editor@Example.com' });

    expect(user).toMatchObject({
      username: 'editor',
      name: 'Editor',
      email: 'editor@example.com',
      role: 'editor',
      disabled: false,
      must_change_password: true,
    });
  });

  test('refuses a taken username or email', async () => {
    await createUser({ email: 'editor@example.com' });

    const sameUsername = await requestJson('POST', '/v1/users', {
      body: { username: 'editor', name: 'Other', role: 'viewer', prehash: createPrehash() },
      token: adminToken,
    });

    const sameEmail = await requestJson('POST', '/v1/users', {
      body: {
        username: 'other',
        name: 'Other',
        email: 'editor@example.com',
        role: 'viewer',
        prehash: createPrehash(),
      },
      token: adminToken,
    });

    expect(sameUsername.status).toBe(409);
    await expect(sameUsername.json()).resolves.toMatchObject({ error: { code: 'username_taken' } });
    expect(sameEmail.status).toBe(409);
    await expect(sameEmail.json()).resolves.toMatchObject({ error: { code: 'email_taken' } });

    // Also when neither has an email
    await createUser({ username: 'no-email' });

    const sameUsernameWithoutEmail = await requestJson('POST', '/v1/users', {
      body: { username: 'no-email', name: 'Other', role: 'viewer', prehash: createPrehash() },
      token: adminToken,
    });

    await expect(sameUsernameWithoutEmail.json()).resolves.toMatchObject({
      error: { code: 'username_taken' },
    });
  });

  test('treats two ways of writing the same email as one', async () => {
    await createUser({ email: 'ren\u00e9@example.com' });

    const decomposed = await requestJson('POST', '/v1/users', {
      body: {
        username: 'other',
        name: 'Other',
        email: 'rene\u0301@example.com',
        role: 'viewer',
        prehash: createPrehash(),
      },
      token: adminToken,
    });

    await expect(decomposed.json()).resolves.toMatchObject({ error: { code: 'email_taken' } });
  });

  test('validates the input', async () => {
    const codes = await Promise.all(
      [
        { role: 'owner' },
        { name: '' },
        // A line break would add a line to the commit messages that credit the user
        { name: 'Ada\nCo-authored-by: Eve <eve@example.com>' },
        { name: 'Ada\u2028Lovelace' },
        { email: 'not an email' },
        { email: 'x@users.invalid' },
        { username: 'no spaces' },
      ].map(async (fields) => {
        const response = await requestJson('POST', '/v1/users', {
          body: {
            username: 'editor',
            name: 'Editor',
            role: 'editor',
            prehash: createPrehash(),
            ...fields,
          },
          token: adminToken,
        });

        return (await response.json()).error.code;
      }),
    );

    expect(codes).toEqual([
      'invalid_role',
      'invalid_name',
      'invalid_name',
      'invalid_name',
      'invalid_email',
      'invalid_email',
      'invalid_username',
    ]);
  });
});

describe('GET /v1/users', () => {
  test('lists users with their last sign-in', async () => {
    await createUser();

    const { users } = await (await requestJson('GET', '/v1/users', { token: adminToken })).json();

    expect(users.map(({ username }) => username)).toEqual(['admin', 'editor']);
    expect(users[0].last_sign_in_at).toMatch(/^\d{4}-/);
    expect(users[1].last_sign_in_at).toBeNull();
  });
});

describe('PATCH /v1/users/:id', () => {
  test('changes the name, email and role', async () => {
    const { user } = await createUser();
    const response = await requestJson('PATCH', `/v1/users/${user.id}`, {
      body: { name: 'Chief Editor', email: 'chief@example.com', role: 'admin' },
      token: adminToken,
    });

    await expect(response.json()).resolves.toMatchObject({
      user: { name: 'Chief Editor', email: 'chief@example.com', role: 'admin' },
    });
  });

  test('removes an email', async () => {
    const { user } = await createUser({ email: 'editor@example.com' });
    const response = await requestJson('PATCH', `/v1/users/${user.id}`, {
      body: { email: null },
      token: adminToken,
    });

    await expect(response.json()).resolves.toMatchObject({ user: { email: null } });
  });

  test('disables a user and ends their sessions', async () => {
    const { user, prehash } = await createUser();
    const token = await signInWithNewPassword('editor', prehash);
    const response = await requestJson('PATCH', `/v1/users/${user.id}`, {
      body: { disabled: true },
      token: adminToken,
    });

    await expect(response.json()).resolves.toMatchObject({ user: { disabled: true } });
    expect((await requestJson('GET', '/v1/auth/session', { token })).status).toBe(401);
  });

  test('keeps at least one admin', async () => {
    const demote = await requestJson('PATCH', `/v1/users/${admin.id}`, {
      body: { role: 'editor' },
      token: adminToken,
    });

    expect(demote.status).toBe(409);
    await expect(demote.json()).resolves.toMatchObject({ error: { code: 'last_admin' } });
  });

  test('refuses to disable yourself', async () => {
    await createUser({ username: 'second', role: 'admin' });

    const response = await requestJson('PATCH', `/v1/users/${admin.id}`, {
      body: { disabled: true },
      token: adminToken,
    });

    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'cannot_disable_self' },
    });
  });

  test('refuses an empty change and an unknown user', async () => {
    const empty = await requestJson('PATCH', `/v1/users/${admin.id}`, {
      body: {},
      token: adminToken,
    });

    const unknown = await requestJson('PATCH', '/v1/users/nobody', {
      body: { name: 'Nobody' },
      token: adminToken,
    });

    expect(empty.status).toBe(400);
    expect(unknown.status).toBe(404);
  });
});

describe('DELETE /v1/users/:id', () => {
  test('deletes a user', async () => {
    const { user, prehash } = await createUser();
    const response = await requestJson('DELETE', `/v1/users/${user.id}`, { token: adminToken });

    expect(response.status).toBe(200);
    await expect(signIn('editor', prehash)).rejects.toThrow('invalid_credentials');
  });

  test('refuses to delete yourself', async () => {
    const response = await requestJson('DELETE', `/v1/users/${admin.id}`, { token: adminToken });

    expect(response.status).toBe(409);
  });
});

describe('POST /v1/users/:id/password', () => {
  test('sets a temporary password and ends the user’s sessions', async () => {
    const { user, prehash } = await createUser();
    const token = await signInWithNewPassword('editor', prehash);
    const temporary = createPrehash();
    const response = await requestJson('POST', `/v1/users/${user.id}/password`, {
      body: { prehash: temporary },
      token: adminToken,
    });

    await expect(response.json()).resolves.toMatchObject({ user: { must_change_password: true } });
    expect((await requestJson('GET', '/v1/auth/session', { token })).status).toBe(401);
    await expect(signIn('editor', temporary)).resolves.toMatch(/\./);
  });
});

describe('DELETE /v1/users/:id/sessions', () => {
  test('signs a user out everywhere', async () => {
    const { user, prehash } = await createUser();
    const token = await signInWithNewPassword('editor', prehash);
    const response = await requestJson('DELETE', `/v1/users/${user.id}/sessions`, {
      token: adminToken,
    });

    expect(response.status).toBe(200);
    expect((await requestJson('GET', '/v1/auth/session', { token })).status).toBe(401);
  });
});
