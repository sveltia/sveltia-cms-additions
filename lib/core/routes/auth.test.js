import { beforeEach, describe, expect, test } from 'vitest';

import {
  ADMIN_SECRET,
  createAdmin,
  createPrehash,
  db,
  request,
  requestJson,
  resetState,
  signIn,
} from '../../test/helpers.js';

beforeEach(resetState);

describe('POST /v1/setup/admin', () => {
  test('creates the first admin', async () => {
    const prehash = createPrehash();
    const response = await requestJson('POST', '/v1/setup/admin', {
      body: { username: 'kohei', name: 'Kohei', prehash },
      token: ADMIN_SECRET,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        username: 'kohei',
        name: 'Kohei',
        email: null,
        role: 'admin',
        disabled: false,
        must_change_password: false,
      },
    });

    const { setup } = await (await request('/version')).json();

    expect(setup.admin).toBe(true);
    await expect(signIn('kohei', prehash)).resolves.toMatch(/\./);
  });

  test('adds the calling origin to the allowed domains when asked', async () => {
    const response = await requestJson('POST', '/v1/setup/admin', {
      body: { username: 'kohei', prehash: createPrehash(), allow_origin: true },
      token: ADMIN_SECRET,
      origin: 'https://cms.example',
    });

    await expect(response.json()).resolves.toMatchObject({ allowed_domains: ['cms.example'] });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://cms.example');
  });

  test('resets an existing admin’s password and enables them again', async () => {
    const { prehash, user } = await createAdmin('kohei');

    // Disable the admin, then recover them with the secret
    await db.run('UPDATE "user" SET banned = 1 WHERE id = ?', [user.id]);

    const newPrehash = createPrehash();
    const response = await requestJson('POST', '/v1/setup/admin', {
      body: { username: 'kohei', prehash: newPrehash },
      token: ADMIN_SECRET,
    });

    expect(response.status).toBe(200);
    await expect(signIn('kohei', prehash)).rejects.toThrow('invalid_credentials');
    await expect(signIn('kohei', newPrehash)).resolves.toMatch(/\./);
  });

  test('refuses to take over a user who isn’t an admin', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);

    await requestJson('POST', '/v1/users', {
      body: { username: 'editor', name: 'Editor', role: 'editor', prehash: createPrehash() },
      token,
    });

    const response = await requestJson('POST', '/v1/setup/admin', {
      body: { username: 'editor', prehash: createPrehash() },
      token: ADMIN_SECRET,
    });

    expect(response.status).toBe(409);
  });

  test('validates the input', async () => {
    const statuses = await Promise.all(
      [
        { username: 'A', prehash: createPrehash() },
        { username: 'admin', prehash: 'plain password' },
      ].map(async (body) => {
        const response = await requestJson('POST', '/v1/setup/admin', {
          body,
          token: ADMIN_SECRET,
        });

        return (await response.json()).error.code;
      }),
    );

    expect(statuses).toEqual(['invalid_username', 'invalid_prehash']);
  });

  test('requires the admin secret', async () => {
    const response = await requestJson('POST', '/v1/setup/admin', {
      body: { username: 'admin', prehash: createPrehash() },
      token: 'wrong',
    });

    expect(response.status).toBe(401);
  });
});

describe('POST /v1/auth/sign-in', () => {
  test('returns a signed session token that works for the session endpoint', async () => {
    const { prehash } = await createAdmin();
    const response = await requestJson('POST', '/v1/auth/sign-in', {
      body: { username: 'Admin', prehash },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.user).toMatchObject({ username: 'admin', role: 'admin' });

    const session = await requestJson('GET', '/v1/auth/session', { token: body.session_token });

    await expect(session.json()).resolves.toMatchObject({
      user: { username: 'admin', has_password: true },
    });
  });

  test('refuses an unsigned session token', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);
    const response = await requestJson('GET', '/v1/auth/session', { token: token.split('.')[0] });

    expect(response.status).toBe(401);
  });

  test('refuses a wrong password and an unknown user alike', async () => {
    await createAdmin();

    const responses = await Promise.all(
      ['admin', 'nobody', 'Not A Username!'].map((username) =>
        requestJson('POST', '/v1/auth/sign-in', { body: { username, prehash: createPrehash() } }),
      ),
    );

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401]);
  });

  test('rate-limits attempts on a username', async () => {
    await createAdmin();

    const statuses = await Array.from({ length: 11 }).reduce(
      async (previous, _, index) => {
        const list = await previous;
        const response = await requestJson('POST', '/v1/auth/sign-in', {
          body: { username: 'admin', prehash: createPrehash() },
          ip: `203.0.113.${index}`,
        });

        return [...list, response.status];
      },
      Promise.resolve(/** @type {number[]} */ ([])),
    );

    expect(statuses.at(-2)).toBe(401);
    expect(statuses.at(-1)).toBe(429);
  });

  test('refuses a disabled user', async () => {
    const { prehash, user } = await createAdmin();

    await db.run('UPDATE "user" SET banned = 1 WHERE id = ?', [user.id]);

    const response = await requestJson('POST', '/v1/auth/sign-in', {
      body: { username: 'admin', prehash },
    });

    expect(response.status).toBe(403);
  });
});

describe('sessions', () => {
  test('end at sign-out', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);

    expect((await requestJson('POST', '/v1/auth/sign-out', { token })).status).toBe(200);
    expect((await requestJson('GET', '/v1/auth/session', { token })).status).toBe(401);
  });

  test('end after seven days even when used', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

    await db.run('UPDATE session SET createdAt = ?', [eightDaysAgo]);

    expect((await requestJson('GET', '/v1/auth/session', { token })).status).toBe(401);
  });

  test('are required', async () => {
    expect((await requestJson('GET', '/v1/auth/session')).status).toBe(401);
    expect((await requestJson('GET', '/v1/auth/session', { token: 'nope.nope' })).status).toBe(401);
  });
});

describe('POST /v1/auth/password', () => {
  test('lets a user with a temporary password change it, then use the API', async () => {
    const admin = await createAdmin();
    const adminToken = await signIn('admin', admin.prehash);
    const temporary = createPrehash();

    await requestJson('POST', '/v1/users', {
      body: { username: 'editor', name: 'Editor', role: 'editor', prehash: temporary },
      token: adminToken,
    });

    const token = await signIn('editor', temporary);
    const session = await (await requestJson('GET', '/v1/auth/session', { token })).json();

    expect(session.user.must_change_password).toBe(true);

    const newPrehash = createPrehash();
    const response = await requestJson('POST', '/v1/auth/password', {
      body: { current_prehash: temporary, new_prehash: newPrehash },
      token,
    });
    const { session_token: newToken } = await response.json();

    expect(response.status).toBe(200);
    expect(newToken).toMatch(/\./);
    expect((await requestJson('GET', '/v1/auth/session', { token })).status).toBe(401);

    const updated = await (
      await requestJson('GET', '/v1/auth/session', { token: newToken })
    ).json();

    expect(updated.user.must_change_password).toBe(false);
    await expect(signIn('editor', newPrehash)).resolves.toMatch(/\./);
  });

  test('refuses a wrong current password', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);
    const response = await requestJson('POST', '/v1/auth/password', {
      body: { current_prehash: createPrehash(), new_prehash: createPrehash() },
      token,
    });

    expect(response.status).toBe(400);
  });

  test('lets a user change their password any time', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);
    const newPrehash = createPrehash();
    const response = await requestJson('POST', '/v1/auth/password', {
      body: { current_prehash: prehash, new_prehash: newPrehash },
      token,
    });

    expect(response.status).toBe(200);
    await expect(signIn('admin', newPrehash)).resolves.toMatch(/\./);
    await expect(signIn('admin', prehash)).rejects.toThrow();
  });

  test('rate-limits wrong current passwords, not right ones', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);

    const statuses = await Array.from({ length: 11 }).reduce(
      async (previous) => {
        const list = await previous;
        const response = await requestJson('POST', '/v1/auth/password', {
          body: { current_prehash: createPrehash(), new_prehash: createPrehash() },
          token,
        });

        return [...list, response.status];
      },
      Promise.resolve(/** @type {number[]} */ ([])),
    );

    expect(statuses.at(-2)).toBe(400);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('PATCH /v1/auth/profile', () => {
  test('lets a user change their own name', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);
    const response = await requestJson('PATCH', '/v1/auth/profile', {
      body: { name: ' Ada Admin ' },
      token,
    });

    expect(response.status).toBe(200);
    expect((await response.json()).user).toMatchObject({ username: 'admin', name: 'Ada Admin' });

    // The session, and so the commit author, has the new name
    const { user } = await (await requestJson('GET', '/v1/auth/session', { token })).json();

    expect(user).toMatchObject({ name: 'Ada Admin' });

    const audit = await db.first('SELECT meta FROM audit_log WHERE action = ?', [
      'auth.profile_update',
    ]);

    expect(JSON.parse(/** @type {any} */ (audit).meta)).toEqual({ fields: ['name'] });
  });

  test('leaves the email to admins, and refuses an invalid name or an empty change', async () => {
    const { prehash } = await createAdmin();
    const token = await signIn('admin', prehash);
    const session = async () =>
      (await (await requestJson('GET', '/v1/auth/session', { token })).json()).user;
    const before = await session();
    const email = await requestJson('PATCH', '/v1/auth/profile', {
      body: { name: 'Ada', email: 'ada@example.com' },
      token,
    });

    // Not even admins change their own email here; the Users page is where it’s done
    expect(email.status).toBe(403);
    expect((await email.json()).error.code).toBe('forbidden');
    // Nothing is changed, not even the name sent with it
    expect(await session()).toEqual(before);
    expect(
      (await requestJson('PATCH', '/v1/auth/profile', { body: { name: ' ' }, token })).status,
    ).toBe(400);
    expect((await requestJson('PATCH', '/v1/auth/profile', { body: {}, token })).status).toBe(400);
  });

  test('waits for a temporary password to be replaced, and requires a session', async () => {
    const admin = await createAdmin();
    const adminToken = await signIn('admin', admin.prehash);
    const temporary = createPrehash();

    await requestJson('POST', '/v1/users', {
      body: { username: 'editor', name: 'Editor', role: 'editor', prehash: temporary },
      token: adminToken,
    });

    const token = await signIn('editor', temporary);

    expect(
      (await requestJson('PATCH', '/v1/auth/profile', { body: { name: 'Ed' }, token })).status,
    ).toBe(403);
    expect((await requestJson('PATCH', '/v1/auth/profile', { body: { name: 'Ed' } })).status).toBe(
      401,
    );
  });
});

describe('GET /v1/setup/status', () => {
  test('tells the setup wizard what has been set up', async () => {
    const before = await (
      await requestJson('GET', '/v1/setup/status', { token: ADMIN_SECRET })
    ).json();

    expect(before).toMatchObject({
      data_key: 'ok',
      admins: 0,
      allowed_domains: [],
      github_app: null,
      installation: null,
    });
    expect(before.site_id).toBe((await (await request('/version')).json()).site_id);

    await requestJson('POST', '/v1/setup/admin', {
      body: { username: 'admin', prehash: createPrehash(), allow_origin: true },
      token: ADMIN_SECRET,
      origin: 'https://cms.example',
    });

    await expect(
      (await requestJson('GET', '/v1/setup/status', { token: ADMIN_SECRET })).json(),
    ).resolves.toMatchObject({ admins: 1, allowed_domains: ['cms.example'] });
  });

  test('requires the admin secret, and counts only failed attempts', async () => {
    const statuses = await Array.from({ length: 12 }).reduce(
      async (previous) => {
        const list = await previous;
        const response = await requestJson('GET', '/v1/setup/status', { token: ADMIN_SECRET });

        return [...list, response.status];
      },
      Promise.resolve(/** @type {number[]} */ ([])),
    );

    expect(statuses.every((status) => status === 200)).toBe(true);

    const wrong = await requestJson('GET', '/v1/setup/status', { token: 'wrong' });

    expect(wrong.status).toBe(401);
  });
});
