import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, test } from 'vitest';

import { installFakeGitHub } from '../../test/fake-github.js';
import {
  ADMIN_SECRET,
  createPrehash,
  getObjectDatabase,
  request,
  requestJson,
  resetState,
} from '../../test/helpers.js';

import { DEFAULT_TENANT, getRegistryObject, getTenantObject, resolveTenant } from './tenants.js';

const ORIGIN = 'https://cms.example';

/**
 * Send a request to the operator API.
 * @param {string} method Method.
 * @param {string} path Path.
 * @param {object} [options] Options.
 * @param {Record<string, any>} [options.body] Body.
 * @param {string} [options.secret] Admin secret.
 * @param {string} [options.ip] Client IP address.
 * @returns {Promise<Response>} Response.
 */
const operator = (method, path, { body, secret = ADMIN_SECRET, ip } = {}) =>
  requestJson(method, path, { body, token: secret, ip });

/**
 * Create a tenant.
 * @param {string} id ID.
 * @returns {Promise<any>} Tenant.
 */
const createTenant = async (id) => {
  const response = await operator('POST', '/v1/tenants', { body: { id, name: `Site ${id}` } });

  expect(response.status).toBe(201);

  return (await response.json()).tenant;
};

/**
 * Create the first admin of a tenant with the admin secret, and sign them in.
 * @param {string} basePath Path the tenant is served at, e.g. `/t/acme`, or an empty string.
 * @returns {Promise<string>} Session token.
 */
const setUpAdmin = async (basePath) => {
  const prehash = createPrehash();

  await requestJson('POST', `${basePath}/v1/setup/admin`, {
    body: { username: 'admin', prehash, allow_origin: true },
    token: ADMIN_SECRET,
    origin: ORIGIN,
  });

  const response = await requestJson('POST', `${basePath}/v1/auth/sign-in`, {
    body: { username: 'admin', prehash },
  });

  return (await response.json()).session_token;
};

beforeEach(async () => {
  await resetState();
});

describe('resolveTenant()', () => {
  test('finds the tenant in the path, or the default one at the root', () => {
    const resolve = (/** @type {string} */ path) =>
      resolveTenant(new URL(`https://w.example${path}`));

    expect(resolve('/v1/users')).toEqual({
      tenant: DEFAULT_TENANT,
      path: '/v1/users',
      basePath: '',
    });
    expect(resolve('/t/acme/v1/users')).toEqual({
      tenant: 'acme',
      path: '/v1/users',
      basePath: '/t/acme',
    });
    expect(resolve('/t/acme')).toEqual({ tenant: 'acme', path: '/', basePath: '/t/acme' });
    // Not a tenant ID, or the default tenant under another URL
    expect(resolve('/t/Acme/v1/users')).toBeNull();
    expect(resolve('/t/-acme/version')).toBeNull();
    expect(resolve('/t/')).toBeNull();
    expect(resolve(`/t/${DEFAULT_TENANT}/version`)).toBeNull();
  });
});

describe('operator API', () => {
  test('creates a tenant asked for twice at once only once', async () => {
    const statuses = await Promise.all(
      ['Acme', 'Other'].map(
        async (name) =>
          (await operator('POST', '/v1/tenants', { body: { id: 'acme', name } })).status,
      ),
    );

    expect(statuses.toSorted()).toEqual([201, 409]);

    const { tenants } = await (await operator('GET', '/v1/tenants')).json();
    const stored = await runInDurableObject(getTenantObject(env, 'acme'), (_instance, state) =>
      state.storage.get('tenant'),
    );

    // The site and the list agree on which request won
    expect(tenants).toHaveLength(1);
    expect(stored).toMatchObject({ id: 'acme', name: tenants[0].name });
  });

  test('creates, lists and deletes tenants', async () => {
    await expect(createTenant('acme')).resolves.toMatchObject({
      id: 'acme',
      name: 'Site acme',
      url: 'https://additions.example/t/acme',
    });
    await createTenant('beta');

    const list = await (await operator('GET', '/v1/tenants')).json();

    expect(list.tenants.map(({ id }) => id)).toEqual(['acme', 'beta']);

    // A tenant’s data goes with it
    await setUpAdmin('/t/acme');
    expect((await operator('DELETE', '/v1/tenants/acme')).status).toBe(200);
    expect((await requestJson('GET', '/t/acme/version')).status).toBe(404);
    await expect(
      getObjectDatabase(getTenantObject(env, 'acme')).first(
        "SELECT name FROM sqlite_master WHERE name = 'user'",
      ),
    ).resolves.toBeNull();

    const after = await (await operator('GET', '/v1/tenants')).json();

    expect(after.tenants.map(({ id }) => id)).toEqual(['beta']);
    expect((await operator('DELETE', '/v1/tenants/acme')).status).toBe(404);
  });

  test('refuses invalid or taken IDs and names', async () => {
    await createTenant('acme');

    const responses = await Promise.all(
      [
        { id: 'acme' },
        { id: DEFAULT_TENANT },
        { id: 'Acme' },
        { id: 'a'.repeat(33) },
        { id: 42 },
        { id: 'gamma', name: '' },
        { id: 'gamma', name: 'x'.repeat(101) },
      ].map((body) => operator('POST', '/v1/tenants', { body })),
    );

    expect(await Promise.all(responses.map(async (r) => (await r.json()).error.code))).toEqual([
      'tenant_exists',
      'invalid_tenant_id',
      'invalid_tenant_id',
      'invalid_tenant_id',
      'invalid_tenant_id',
      'invalid_tenant_name',
      'invalid_tenant_name',
    ]);
  });

  test('needs the admin secret, with attempts counted across every tenant', async () => {
    const wrong = await operator('GET', '/v1/tenants', { secret: 'nope', ip: '192.0.2.7' });

    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('access-control-allow-origin')).toBeNull();
    await createTenant('acme');

    // Nine more wrong attempts spread over the tenants use up the client’s limit everywhere
    await Promise.all(
      ['', '', '', '/t/acme', '/t/acme', '/t/acme', '', '/t/acme', ''].map((basePath) =>
        requestJson('POST', `${basePath}/v1/setup/secret`, {
          body: {},
          token: 'nope',
          ip: '192.0.2.7',
        }),
      ),
    );

    const blocked = await requestJson('POST', '/t/acme/v1/setup/secret', {
      body: {},
      token: 'nope',
      ip: '192.0.2.7',
    });

    expect(blocked.status).toBe(429);
    expect((await operator('GET', '/v1/tenants', { ip: '192.0.2.7' })).status).toBe(429);
  });

  test('can be called from any origin, as the setup wizard does', async () => {
    const preflight = await request('/v1/tenants/acme', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'DELETE' },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');

    const list = await requestJson('GET', '/v1/tenants', { token: ADMIN_SECRET, origin: ORIGIN });

    expect(list.status).toBe(200);
    expect(list.headers.get('access-control-allow-origin')).toBe(ORIGIN);

    // Errors too, so the wizard can show why
    const wrong = await requestJson('GET', '/v1/tenants', { token: 'nope', origin: ORIGIN });

    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  test('isn’t served under a tenant, so a tenant’s wizard can tell', async () => {
    await createTenant('acme');

    const response = await requestJson('GET', '/t/acme/v1/tenants', {
      token: ADMIN_SECRET,
      origin: ORIGIN,
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_found' } });
  });
});

/**
 * List the tables a Durable Object instance has.
 * @param {string} tenant Tenant ID.
 * @returns {Promise<string[]>} Table names.
 */
const listTables = (tenant) =>
  runInDurableObject(getTenantObject(env, tenant), (_instance, state) =>
    state.storage.sql
      // Leaving out the runtime’s own tables, e.g. for the alarm
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .toArray()
      .map(({ name }) => String(name)),
  );

describe('tenant lifecycle', () => {
  test('starts afresh when created again after being deleted', async () => {
    await createTenant('acme');
    await setUpAdmin('/t/acme');

    const keyOf = async () =>
      (await getObjectDatabase(getTenantObject(env, 'acme')).first('SELECT wrapped FROM data_key'))
        ?.wrapped;

    const before = await keyOf();

    await operator('DELETE', '/v1/tenants/acme');
    await createTenant('acme');

    // Nothing of the deleted tenant is remembered, such as its data key
    const { setup } = await (await requestJson('GET', '/t/acme/version')).json();

    expect(setup).toMatchObject({ admin: false, data_key: 'ok' });
    expect(await keyOf()).toEqual(expect.any(String));
    expect(await keyOf()).not.toBe(before);
  });

  test('leaves nothing behind for a tenant that doesn’t exist', async () => {
    expect((await requestJson('GET', '/t/nobody/version')).status).toBe(404);
    await expect(listTables('nobody')).resolves.toEqual([]);
  });

  test('doesn’t bring a deleted tenant back with an alarm left behind', async () => {
    await createTenant('acme');
    await setUpAdmin('/t/acme');
    await operator('DELETE', '/v1/tenants/acme');

    const stub = getTenantObject(env, 'acme');

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    await expect(listTables('acme')).resolves.toEqual([]);
  });

  test('completes a tenant whose creation failed halfway', async () => {
    // Listed, but never created
    await getRegistryObject(env).addTenant({
      id: 'acme',
      name: 'Acme',
      created_at: new Date().toISOString(),
    });
    expect((await requestJson('GET', '/t/acme/version')).status).toBe(404);

    await createTenant('acme');
    expect((await requestJson('GET', '/t/acme/version')).status).toBe(200);
  });
});

describe('routing', () => {
  test('serves only the tenants that exist', async () => {
    expect((await requestJson('GET', '/t/acme/version')).status).toBe(404);
    expect((await requestJson('GET', '/t/Acme/version')).status).toBe(404);
    expect((await requestJson('GET', `/t/${DEFAULT_TENANT}/version`)).status).toBe(404);

    await createTenant('acme');
    expect((await requestJson('GET', '/t/acme/version')).status).toBe(200);
  });

  test('keeps every tenant’s users, sessions, settings and keys apart', async () => {
    await createTenant('acme');

    const acmeToken = await setUpAdmin('/t/acme');
    const acme = await (await requestJson('GET', '/t/acme/version')).json();
    const root = await (await requestJson('GET', '/version')).json();

    // Each tenant has its own site ID, which salts the passwords, and its own setup
    expect(acme.site_id).not.toBe(root.site_id);
    expect(acme.setup.admin).toBe(true);
    expect(root.setup.admin).toBe(false);

    // A session of one tenant means nothing to another
    expect((await requestJson('GET', '/t/acme/v1/auth/session', { token: acmeToken })).status).toBe(
      200,
    );
    expect((await requestJson('GET', '/v1/auth/session', { token: acmeToken })).status).toBe(401);

    // The other tenant has neither the user nor the allowed domain
    await expect(
      requestJson('POST', '/v1/auth/sign-in', {
        body: { username: 'admin', prehash: createPrehash() },
      }),
    ).resolves.toHaveProperty('status', 401);
    expect(
      (await requestJson('GET', '/v1/locks', { origin: ORIGIN })).headers.get(
        'access-control-allow-origin',
      ),
    ).toBeNull();

    // Every tenant has its own data key
    const keyOf = (/** @type {string} */ tenant) =>
      getObjectDatabase(getTenantObject(env, tenant)).first('SELECT wrapped FROM data_key');

    expect((await keyOf('acme'))?.wrapped).not.toBe((await keyOf(DEFAULT_TENANT))?.wrapped);

    // Another tenant can have a user with the same name
    await expect(setUpAdmin('')).resolves.toMatch(/^.+\..+$/);
  });

  test('hands out links that lead back to the tenant, whatever the client claims', async () => {
    const github = await installFakeGitHub();

    try {
      await createTenant('acme');

      // Headers only the Worker may set
      const response = await request('/t/acme/v1/setup/github', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ADMIN_SECRET}`,
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'X-Additions-Tenant': DEFAULT_TENANT,
          'X-Additions-Base-URL': 'https://evil.example',
        },
        body: JSON.stringify({ repo: 'sveltia/site', return_url: `${ORIGIN}/admin/` }),
      });

      expect(response.status).toBe(200);

      const { manifest } = await response.json();

      expect(manifest.redirect_url).toBe(
        'https://additions.example/t/acme/v1/setup/github/callback',
      );
      expect(manifest.callback_urls).toEqual([
        'https://additions.example/t/acme/v1/auth/callback/github',
      ]);
    } finally {
      github.restore();
    }
  });
});
