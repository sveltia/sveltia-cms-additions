import { beforeEach, describe, expect, test } from 'vitest';

import { setAllowedDomains } from '../../core/allowed-domains.js';
import { getDataKeys, rekeyDataKey } from '../../core/crypto/data-key.js';
import { getSecretSetting, getSetting, setSecretSetting, setSetting } from '../../core/settings.js';
import { ADMIN_SECRET, db, request, resetState } from '../../test/helpers.js';

const PREVIOUS_SECRET = 'previous-secret-0123456789abcdefghijklmn';

/**
 * Send a request authenticated with an admin secret.
 * @param {string} path Path.
 * @param {Record<string, any>} body JSON body.
 * @param {object} [options] Options.
 * @param {string} [options.secret] Admin secret.
 * @param {string} [options.ip] Client IP address.
 * @returns {Promise<Response>} Response.
 */
const postWithSecret = (path, body, { secret = ADMIN_SECRET, ip = '198.51.100.1' } = {}) =>
  request(path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify(body),
  });

beforeEach(async () => {
  await resetState();
});

describe('GET /', () => {
  test('names the product and points to the CMS', async () => {
    const response = await request('/');

    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('Use admin secret');
  });
});

describe('GET /version', () => {
  test('describes the service and its setup state', async () => {
    const response = await request('/version');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      name: 'Sveltia CMS Additions',
      package: '@sveltia/cms-additions',
      api: 1,
      platform: 'cloudflare',
      git_host: 'github',
      kdf: 'v1',
      setup: { admin_secret: 'ok', data_key: 'ok', admin: false, github_app: false },
    });
    expect(body.site_id).toMatch(/^[\da-f-]{36}$/);
  });

  test('keeps the same site ID', async () => {
    const first = await (await request('/version')).json();
    const second = await (await request('/version')).json();

    expect(second.site_id).toBe(first.site_id);
  });

  test('can be read from any origin', async () => {
    const response = await request('/version', { headers: { Origin: 'https://cms.example' } });

    expect(response.headers.get('access-control-allow-origin')).toBe('https://cms.example');
  });

  test('reports a locked data key', async () => {
    await rekeyDataKey(db, PREVIOUS_SECRET);

    const { setup } = await (await request('/version')).json();

    expect(setup.data_key).toBe('locked');
  });
});

describe('CORS', () => {
  test('refuses an origin that isn’t allowed, failing closed while the list is empty', async () => {
    const response = await request('/nothing', { headers: { Origin: 'https://cms.example' } });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'origin_not_allowed' },
    });
  });

  test('allows a listed origin, including errors and preflights', async () => {
    await setAllowedDomains(db, ['cms.example']);

    const response = await request('/nothing', { headers: { Origin: 'https://cms.example' } });

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://cms.example');

    const preflight = await request('/v1/users', {
      method: 'OPTIONS',
      headers: { Origin: 'https://cms.example', 'Access-Control-Request-Method': 'GET' },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization');
  });

  test('lets requests without an origin through', async () => {
    const response = await request('/nothing');

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST /v1/setup/secret', () => {
  test('requires the admin secret', async () => {
    const response = await postWithSecret('/v1/setup/secret', { rekey: true }, { secret: 'nope' });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'wrong_admin_secret' },
    });
  });

  test('limits a burst of parallel attempts too', async () => {
    const responses = await Promise.all(
      Array.from({ length: 15 }, () =>
        postWithSecret('/v1/setup/secret', {}, { secret: 'nope', ip: '192.0.2.50' }),
      ),
    );

    const statuses = responses.map(({ status }) => status);

    expect(statuses.filter((status) => status === 401)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });

  test('rate-limits attempts per client', async () => {
    const ip = '192.0.2.99';

    const statuses = await Array.from({ length: 11 }).reduce(
      async (previous) => {
        const list = await previous;
        const response = await postWithSecret('/v1/setup/secret', {}, { secret: 'nope', ip });

        return [...list, response.status];
      },
      Promise.resolve(/** @type {number[]} */ ([])),
    );

    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test('re-wraps a data key wrapped with the previous secret', async () => {
    await rekeyDataKey(db, PREVIOUS_SECRET);

    const before = await getDataKeys(db, PREVIOUS_SECRET);
    const response = await postWithSecret('/v1/setup/secret', { previous: PREVIOUS_SECRET });

    expect(response.status).toBe(200);

    const after = await getDataKeys(db, ADMIN_SECRET);

    expect(after.status).toBe('ok');
    expect(after.status === 'ok' && before.status === 'ok' && after.keys.signingSecret).toBe(
      before.status === 'ok' && before.keys.signingSecret,
    );
  });

  test('refuses a wrong previous secret', async () => {
    await rekeyDataKey(db, PREVIOUS_SECRET);

    const response = await postWithSecret('/v1/setup/secret', { previous: 'wrong' });

    expect(response.status).toBe(400);
  });

  test('re-keys a locked data key and deletes what can no longer be read', async () => {
    await rekeyDataKey(db, PREVIOUS_SECRET);

    const previous = await getDataKeys(db, PREVIOUS_SECRET);

    if (previous.status !== 'ok') {
      throw new Error('Unexpected state.');
    }

    await setSecretSetting(db, previous.keys, 'github_app_private_key', 'secret value');
    await setSetting(db, 'github_app', { id: 1, slug: 'app' });
    await setSetting(db, 'github_installation', { id: 2, owner: 'o', name: 'n' });

    const response = await postWithSecret('/v1/setup/secret', { rekey: true });

    await expect(response.json()).resolves.toEqual({
      data_key: 'ok',
      deleted: ['github_app_private_key'],
    });

    const current = await getDataKeys(db, ADMIN_SECRET);

    expect(current.status).toBe('ok');
    await expect(
      current.status === 'ok' && getSecretSetting(db, current.keys, 'github_app_private_key'),
    ).resolves.toBeUndefined();

    // The app is unusable without its key, so the setup wizard offers to connect GitHub again
    await expect(getSetting(db, 'github_app')).resolves.toBeUndefined();
    await expect(getSetting(db, 'github_installation')).resolves.toBeUndefined();

    const log = await db.all('SELECT action FROM audit_log');

    expect(log).toEqual([{ action: 'data_key.rekey' }]);
  });

  test('refuses to re-key a data key that can still be unlocked', async () => {
    await getDataKeys(db, ADMIN_SECRET);

    const response = await postWithSecret('/v1/setup/secret', { rekey: true });

    expect(response.status).toBe(409);
  });

  test('rejects a body without an action', async () => {
    const response = await postWithSecret('/v1/setup/secret', {});

    expect(response.status).toBe(400);
  });
});
