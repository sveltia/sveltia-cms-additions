import { beforeAll, describe, expect, test, vi } from 'vitest';

import { createApp } from '../../core/app.js';
import { GRACE_PERIOD } from '../../core/locks.js';
import { HEARTBEAT_TTL } from '../../core/presence.js';

import { createMemoryPlatform } from './index.js';

/**
 * The core on a platform without live updates, where each CMS tab sends heartbeats and changes
 * locks with requests of its own.
 */

const ADMIN_SECRET = 'test-admin-secret-0123456789abcdefghijklmnopqrstuvwxyz';
const env = { ADMIN_SECRET };
const memory = createMemoryPlatform();
const app = createApp(memory.platform, { gitProviders: memory.gitProviders });

/**
 * Send a JSON request.
 * @param {string} method Method.
 * @param {string} path Path.
 * @param {{ body?: Record<string, any>, token?: string }} [options] Options.
 * @returns {Promise<Response>} Response.
 */
const send = (method, path, { body, token } = {}) =>
  app.fetch(
    new Request(`https://additions.example${path}`, {
      method,
      headers: {
        'CF-Connecting-IP': '198.51.100.1',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    env,
  );

/**
 * Create a user who has set their own password, and sign them in.
 * @param {string} username Username.
 * @param {string} role Role.
 * @param {string} adminToken Admin’s session token.
 * @returns {Promise<string>} Session token.
 */
const createSignedInUser = async (username, role, adminToken) => {
  const temporary = crypto.randomUUID().replaceAll('-', '').padEnd(43, 'a');

  await send('POST', '/v1/users', {
    body: { username, name: username.toUpperCase(), role, prehash: temporary },
    token: adminToken,
  });

  const token = (
    await (
      await send('POST', '/v1/auth/sign-in', { body: { username, prehash: temporary } })
    ).json()
  ).session_token;
  const changed = await send('POST', '/v1/auth/password', {
    body: {
      current_prehash: temporary,
      new_prehash: crypto.randomUUID().replaceAll('-', '').padEnd(43, 'b'),
    },
    token,
  });

  return (await changed.json()).session_token;
};

/** @type {string} */
let adminToken;
/** @type {string} */
let ada;
/** @type {string} */
let bob;

beforeAll(async () => {
  const prehash = crypto.randomUUID().replaceAll('-', '').padEnd(43, 'c');

  await send('POST', '/v1/setup/admin', {
    body: { username: 'admin', prehash },
    token: ADMIN_SECRET,
  });

  adminToken = (
    await (await send('POST', '/v1/auth/sign-in', { body: { username: 'admin', prehash } })).json()
  ).session_token;

  ada = await createSignedInUser('ada', 'editor', adminToken);
  bob = await createSignedInUser('bob', 'editor', adminToken);
});

describe('a platform without live updates', () => {
  test('says so, and has no socket', async () => {
    await expect((await send('GET', '/version')).json()).resolves.toMatchObject({
      platform: 'memory',
      realtime: 'none',
    });
    expect((await send('GET', '/v1/socket')).status).toBe(404);
  });

  test('tells every tab who has which entry open, from their heartbeats', async () => {
    const heartbeat = await send('POST', '/v1/presence', {
      body: { connection: 'ada-tab-1', open: ['posts/hello'] },
      token: ada,
    });

    expect(heartbeat.status).toBe(200);

    const { presence } = await (
      await send('POST', '/v1/presence', {
        body: { connection: 'bob-tab-1', open: [] },
        token: bob,
      })
    ).json();

    expect(presence['posts/hello']).toEqual([
      expect.objectContaining({ connection: 'ada-tab-1', name: 'ADA' }),
    ]);
  });

  test('refuses a tab ID that belongs to someone else, and invalid heartbeats', async () => {
    const steal = await send('POST', '/v1/presence', {
      body: { connection: 'ada-tab-1', open: [] },
      token: bob,
    });

    expect(steal.status).toBe(400);
    await expect(steal.json()).resolves.toMatchObject({ error: { code: 'invalid_connection' } });

    const tooMany = await send('POST', '/v1/presence', {
      body: { connection: 'bob-tab-1', open: ['a', 'b', 'c', 'd'] },
      token: bob,
    });

    expect(tooMany.status).toBe(400);
  });

  test('changes locks over HTTP, for the user’s own live tabs only', async () => {
    const acquire = (token, connection) =>
      send('POST', '/v1/locks', { body: { type: 'acquire', key: 'posts/a', connection }, token });

    // Not one of Bob’s tabs
    expect((await acquire(bob, 'ada-tab-1')).status).toBe(409);

    const acquired = await acquire(ada, 'ada-tab-1');

    expect(acquired.status).toBe(200);
    await expect(acquired.json()).resolves.toMatchObject({
      lock: { key: 'posts/a', user_id: expect.any(String), connection: 'ada-tab-1' },
    });

    const refused = await acquire(bob, 'bob-tab-1');

    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      error: { code: 'held' },
      lock: { connection: 'ada-tab-1' },
    });

    const taken = await send('POST', '/v1/locks', {
      body: { type: 'takeover', key: 'posts/a', connection: 'bob-tab-1' },
      token: bob,
    });

    expect(taken.status).toBe(200);

    const released = await send('POST', '/v1/locks', {
      body: { type: 'release', key: 'posts/a', connection: 'bob-tab-1' },
      token: bob,
    });

    await expect(released.json()).resolves.toEqual({ released: true });
  });

  test('releases the locks of a tab that stops sending heartbeats, after the grace period', async () => {
    await send('POST', '/v1/presence', { body: { connection: 'ada-tab-2', open: [] }, token: ada });
    await send('POST', '/v1/locks', {
      body: { type: 'acquire', key: 'posts/b', connection: 'ada-tab-2' },
      token: ada,
    });

    const now = Date.now();

    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      // The tab has stopped: its lock starts its grace period, then is released
      vi.setSystemTime(now + HEARTBEAT_TTL + 1);
      await memory.runJobs(env);
      vi.setSystemTime(now + HEARTBEAT_TTL + GRACE_PERIOD + 2);
      await memory.runJobs(env);
    } finally {
      vi.useRealTimers();
    }

    const { locks } = await (await send('GET', '/v1/locks', { token: bob })).json();

    expect(locks.find(({ key }) => key === 'posts/b')).toBeUndefined();
  });

  test('lets a tab whose heartbeats resume keep its locks', async () => {
    await send('POST', '/v1/presence', { body: { connection: 'ada-tab-4', open: [] }, token: ada });
    await send('POST', '/v1/locks', {
      body: { type: 'acquire', key: 'posts/d', connection: 'ada-tab-4' },
      token: ada,
    });

    const now = Date.now();

    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      // A gap orphans the lock; the next heartbeat takes it back before the grace period ends
      vi.setSystemTime(now + HEARTBEAT_TTL + 1);
      await memory.runJobs(env);
      await send('POST', '/v1/presence', {
        body: { connection: 'ada-tab-4', open: [] },
        token: ada,
      });
      vi.setSystemTime(now + HEARTBEAT_TTL + GRACE_PERIOD + 2);
      await memory.runJobs(env);
    } finally {
      vi.useRealTimers();
    }

    const { locks } = await (await send('GET', '/v1/locks', { token: ada })).json();

    expect(locks.find(({ key }) => key === 'posts/d')).toMatchObject({ connection: 'ada-tab-4' });
  });

  test('keeps a closed tab’s ID, and its locks, from anyone else', async () => {
    await send('POST', '/v1/presence', { body: { connection: 'ada-tab-5', open: [] }, token: ada });
    await send('POST', '/v1/locks', {
      body: { type: 'acquire', key: 'posts/e', connection: 'ada-tab-5' },
      token: ada,
    });
    await send('DELETE', '/v1/presence/ada-tab-5', { token: ada });

    // Bob read the tab ID from the lock list, but can’t claim it while Ada’s lock is there
    const claim = await send('POST', '/v1/presence', {
      body: { connection: 'ada-tab-5', open: [] },
      token: bob,
    });

    expect(claim.status).toBe(400);

    const release = await send('POST', '/v1/locks', {
      body: { type: 'release', key: 'posts/e', connection: 'ada-tab-5' },
      token: bob,
    });

    expect(release.status).toBe(409);

    const { locks } = await (await send('GET', '/v1/locks', { token: ada })).json();

    expect(locks.find(({ key }) => key === 'posts/e')).toMatchObject({ connection: 'ada-tab-5' });
  });

  test('gives a closed tab’s locks the grace period at once', async () => {
    await send('POST', '/v1/presence', { body: { connection: 'ada-tab-3', open: [] }, token: ada });
    await send('POST', '/v1/locks', {
      body: { type: 'acquire', key: 'posts/c', connection: 'ada-tab-3' },
      token: ada,
    });

    expect((await send('DELETE', '/v1/presence/ada-tab-3', { token: ada })).status).toBe(200);

    const { locks } = await (await send('GET', '/v1/locks', { token: ada })).json();
    const row = memory.database.prepare("SELECT orphaned_at FROM lock WHERE key = 'posts/c'").get();

    expect(locks.find(({ key }) => key === 'posts/c')).toBeDefined();
    expect(row?.orphaned_at).toEqual(expect.any(Number));
  });

  test('lets a demoted user’s locks go, even while their tab keeps sending heartbeats', async () => {
    await send('POST', '/v1/presence', { body: { connection: 'ada-tab-6', open: [] }, token: ada });
    await send('POST', '/v1/locks', {
      body: { type: 'acquire', key: 'posts/f', connection: 'ada-tab-6' },
      token: ada,
    });

    const { users } = await (await send('GET', '/v1/users', { token: adminToken })).json();
    const { id } = users.find(({ username }) => username === 'ada');

    await send('PATCH', `/v1/users/${id}`, { body: { role: 'viewer' }, token: adminToken });

    const now = Date.now();

    vi.useFakeTimers({ toFake: ['Date'] });

    try {
      // The demotion forgot the tab, so its lock starts its grace period; the heartbeats it keeps
      // sending, now as a viewer’s, don’t take it back
      vi.setSystemTime(now + 1);
      await memory.runJobs(env);
      await send('POST', '/v1/presence', {
        body: { connection: 'ada-tab-6', open: [] },
        token: ada,
      });
      vi.setSystemTime(now + GRACE_PERIOD + 2);
      await memory.runJobs(env);
    } finally {
      vi.useRealTimers();
    }

    const { locks } = await (await send('GET', '/v1/locks', { token: bob })).json();

    expect(locks.find(({ key }) => key === 'posts/f')).toBeUndefined();
  });
});
