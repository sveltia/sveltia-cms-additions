import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ADMIN_SECRET,
  createAdmin,
  createPrehash,
  getLockObject,
  request,
  requestJson,
  resetState,
  signIn,
} from '../../test/helpers.js';
import { GRACE_PERIOD } from '../locks.js';

const ORIGIN = 'https://cms.example';

/** @type {string} */
let adminToken;

/** @type {WebSocket[]} */
const sockets = [];

/**
 * A lock connection, with the messages it has received.
 * @typedef {object} TestConnection
 * @property {WebSocket} ws Socket.
 * @property {any[]} messages Messages received, parsed.
 * @property {(predicate: (message: any) => boolean) => Promise<any>} next Wait for a message.
 */

/**
 * Open a lock connection for a session.
 * @param {string} token Session token.
 * @returns {Promise<TestConnection>} Connection.
 */
const connect = async (token) => {
  const { ticket } = await (
    await requestJson('POST', '/v1/socket/ticket', { token, origin: ORIGIN })
  ).json();

  const response = await request(`/v1/socket?ticket=${ticket}`, {
    headers: { Upgrade: 'websocket', Origin: ORIGIN },
  });

  const ws = /** @type {WebSocket} */ (response.webSocket);
  /** @type {any[]} */
  const messages = [];

  ws.accept();
  ws.addEventListener('message', ({ data }) => {
    messages.push(JSON.parse(/** @type {string} */ (data)));
  });
  sockets.push(ws);

  return {
    ws,
    messages,
    next: (predicate) =>
      vi.waitFor(() => {
        const message = messages.find(predicate);

        if (!message) {
          throw new Error('Not yet');
        }

        return message;
      }),
  };
};

/**
 * Create a user who has changed their temporary password, and sign them in.
 * @param {string} username Username.
 * @param {string} role Role.
 * @returns {Promise<string>} Session token.
 */
const createSignedInUser = async (username, role) => {
  const temporary = createPrehash();

  await requestJson('POST', '/v1/users', {
    body: { username, name: username.toUpperCase(), role, prehash: temporary },
    token: adminToken,
  });

  const changed = await requestJson('POST', '/v1/auth/password', {
    body: { current_prehash: temporary, new_prehash: createPrehash() },
    token: await signIn(username, temporary),
  });

  return (await changed.json()).session_token;
};

/**
 * Send a message.
 * @param {TestConnection} connection Connection.
 * @param {Record<string, any>} message Message.
 */
const send = (connection, message) => {
  connection.ws.send(JSON.stringify(message));
};

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

afterEach(() => {
  sockets.splice(0).forEach((ws) => ws.close());
});

describe('lock connections', () => {
  test('share locks between editors, who can take them over', async () => {
    const editorToken = await createSignedInUser('editor', 'editor');
    const admin = await connect(adminToken);
    const editor = await connect(editorToken);

    const snapshot = await admin.next(({ type }) => type === 'snapshot');

    expect(snapshot).toEqual({
      type: 'snapshot',
      connection: expect.any(String),
      user_id: expect.any(String),
      locks: [],
      presence: {},
    });

    send(admin, { type: 'acquire', key: 'posts/hello@main' });

    // Everyone hears about it
    const acquired = await editor.next(({ type }) => type === 'changed');

    expect(acquired).toMatchObject({
      key: 'posts/hello@main',
      lock: { name: 'admin', connection: snapshot.connection, user_id: snapshot.user_id },
    });

    send(editor, { type: 'acquire', key: 'posts/hello@main' });
    await expect(editor.next(({ type }) => type === 'refused')).resolves.toMatchObject({
      reason: 'held',
      lock: { name: 'admin' },
    });

    send(editor, { type: 'takeover', key: 'posts/hello@main' });
    await expect(
      admin.next(({ type, lock }) => type === 'changed' && lock?.name === 'EDITOR'),
    ).resolves.toMatchObject({ key: 'posts/hello@main' });

    // A new connection gets the current locks, also over plain HTTP
    const later = await connect(adminToken);

    await expect(later.next(({ type }) => type === 'snapshot')).resolves.toMatchObject({
      locks: [{ key: 'posts/hello@main', name: 'EDITOR' }],
    });
    await expect(
      (await requestJson('GET', '/v1/locks', { token: adminToken, origin: ORIGIN })).json(),
    ).resolves.toMatchObject({ locks: [{ name: 'EDITOR' }] });

    send(editor, { type: 'release', key: 'posts/hello@main' });
    await expect(
      admin.next(({ type, lock }) => type === 'changed' && lock === null),
    ).resolves.toMatchObject({ key: 'posts/hello@main' });
  });

  test('keep the locks of a closed connection for a grace period', async () => {
    const admin = await connect(adminToken);
    const other = await connect(await createSignedInUser('editor', 'editor'));

    send(admin, { type: 'acquire', key: 'posts/a@main' });
    await other.next(({ type }) => type === 'changed');
    admin.ws.close();

    // The release is scheduled, not immediate
    await vi.waitFor(async () => {
      const alarm = await runInDurableObject(getLockObject(), (_instance, state) =>
        state.storage.getAlarm(),
      );

      expect(alarm).toBeGreaterThan(Date.now() + GRACE_PERIOD - 5000);
    });

    // Pretend the grace period is over
    await runInDurableObject(getLockObject(), (_instance, state) => {
      state.storage.sql.exec('UPDATE lock SET orphaned_at = ?', Date.now() - GRACE_PERIOD);
    });
    await runDurableObjectAlarm(getLockObject());

    await expect(
      other.next(({ type, lock }) => type === 'changed' && lock === null),
    ).resolves.toMatchObject({ key: 'posts/a@main' });
  });

  test('keep viewers from acquiring locks', async () => {
    const viewer = await connect(await createSignedInUser('viewer', 'viewer'));

    send(viewer, { type: 'acquire', key: 'posts/a@main' });
    await expect(viewer.next(({ type }) => type === 'refused')).resolves.toMatchObject({
      reason: 'forbidden',
    });
  });

  test('tell everyone who has an entry open, viewers included, until they close it', async () => {
    const viewer = await connect(await createSignedInUser('viewer', 'viewer'));
    const admin = await connect(adminToken);
    const { connection } = await viewer.next(({ type }) => type === 'snapshot');

    send(viewer, { type: 'open', key: 'posts/a@main' });

    await expect(
      admin.next(({ type, viewers }) => type === 'presence' && viewers.length === 1),
    ).resolves.toEqual({
      type: 'presence',
      key: 'posts/a@main',
      viewers: [{ connection, user_id: expect.any(String), name: 'VIEWER' }],
    });

    // A new connection starts with who has what open
    const late = await connect(adminToken);

    await expect(late.next(({ type }) => type === 'snapshot')).resolves.toMatchObject({
      presence: { 'posts/a@main': [{ connection, name: 'VIEWER' }] },
    });

    send(viewer, { type: 'close', key: 'posts/a@main' });
    await expect(
      admin.next(({ type, viewers }) => type === 'presence' && viewers.length === 0),
    ).resolves.toMatchObject({ key: 'posts/a@main' });

    // Closing the connection closes its entries at once, unlike its locks
    send(viewer, { type: 'open', key: 'posts/b@main' });
    await admin.next(({ type, key }) => type === 'presence' && key === 'posts/b@main');
    viewer.ws.close();
    await expect(
      late.next(
        ({ type, key, viewers }) =>
          type === 'presence' && key === 'posts/b@main' && viewers.length === 0,
      ),
    ).resolves.toBeTruthy();

    // A bad request is answered with an error, not with a broadcast
    send(admin, { type: 'open', key: '' });
    await expect(admin.next(({ type }) => type === 'error')).resolves.toEqual({
      type: 'error',
      code: 'invalid_message',
    });
  });

  test('stop listing every tab of a user whose access changes at once', async () => {
    const editorToken = await createSignedInUser('editor', 'editor');
    const { user } = await (
      await requestJson('GET', '/v1/auth/session', { token: editorToken })
    ).json();
    const tabs = [await connect(editorToken), await connect(editorToken)];
    const admin = await connect(adminToken);

    await Promise.all(tabs.map((tab) => tab.next(({ type }) => type === 'snapshot')));
    tabs.forEach((tab) => send(tab, { type: 'open', key: 'posts/a@main' }));
    await admin.next(({ type, viewers }) => type === 'presence' && viewers.length === 2);

    const seen = admin.messages.length;

    await requestJson('PATCH', `/v1/users/${user.id}`, {
      body: { role: 'viewer' },
      token: adminToken,
    });

    // Every presence update since lists none of the editor’s tabs
    await admin.next(({ type, viewers }) => type === 'presence' && viewers.length === 0);

    const updates = admin.messages
      .slice(seen)
      .filter(({ type, key }) => type === 'presence' && key === 'posts/a@main');

    expect(updates.length).toBeGreaterThan(0);
    updates.forEach(({ viewers }) => expect(viewers).toEqual([]));
  });

  test('are closed once the user’s access changes, and their locks get a grace period', async () => {
    const editorToken = await createSignedInUser('editor', 'editor');
    const editor = await connect(editorToken);
    const admin = await connect(adminToken);
    /** @type {Promise<number>} */
    const closed = new Promise((resolve) => {
      editor.ws.addEventListener('close', ({ code }) => resolve(code));
    });

    send(editor, { type: 'acquire', key: 'posts/a@main' });
    await admin.next(({ type }) => type === 'changed');

    const { users } = await (
      await requestJson('GET', '/v1/users', { token: adminToken, origin: ORIGIN })
    ).json();
    const editorId = users.find(({ username }) => username === 'editor').id;

    // A viewer now: the tab connects again, with the new role
    await requestJson('PATCH', `/v1/users/${editorId}`, {
      body: { role: 'viewer' },
      token: adminToken,
      origin: ORIGIN,
    });

    await expect(closed).resolves.toBe(1008);

    const orphaned = await runInDurableObject(getLockObject(), (_instance, state) =>
      state.storage.sql.exec('SELECT orphaned_at FROM lock').one(),
    );

    expect(orphaned.orphaned_at).not.toBeNull();
  });

  test('start the grace period of locks whose connection is gone without closing', async () => {
    // Left by a connection dropped when the object restarted
    await runInDurableObject(getLockObject(), (_instance, state) => {
      state.storage.sql.exec(
        'INSERT INTO lock (key, user_id, name, since, connection) VALUES (?, ?, ?, ?, ?)',
        'posts/a@main',
        'u-gone',
        'Gone',
        Date.now(),
        'dead-connection',
      );
    });

    await connect(adminToken);

    const lock = await runInDurableObject(getLockObject(), (_instance, state) =>
      state.storage.sql.exec('SELECT orphaned_at FROM lock').one(),
    );

    expect(lock.orphaned_at).not.toBeNull();
  });

  test('give a user only so many tickets in a while', async () => {
    const statuses = await Promise.all(
      Array.from(
        { length: 61 },
        async () =>
          (await requestJson('POST', '/v1/socket/ticket', { token: adminToken, origin: ORIGIN }))
            .status,
      ),
    );

    expect(statuses.filter((status) => status === 200)).toHaveLength(60);
    expect(statuses).toContain(429);
  });

  test('allow a user only so many connections at once', async () => {
    await Promise.all(Array.from({ length: 10 }, () => connect(adminToken)));

    const { ticket } = await (
      await requestJson('POST', '/v1/socket/ticket', { token: adminToken, origin: ORIGIN })
    ).json();
    const response = await request(`/v1/socket?ticket=${ticket}`, {
      headers: { Upgrade: 'websocket', Origin: ORIGIN },
    });

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'too_many_connections' },
    });
  });

  test('close a connection that sends too many messages', async () => {
    const admin = await connect(adminToken);
    /** @type {Promise<number>} */
    const closed = new Promise((resolve) => {
      admin.ws.addEventListener('close', ({ code }) => resolve(code));
    });

    Array.from({ length: 61 }).forEach(() => send(admin, { type: 'release', key: 'x' }));

    await expect(closed).resolves.toBe(1008);
  });

  test('need a valid ticket, a WebSocket and a session', async () => {
    const response = await request('/v1/socket?ticket=nope', {
      headers: { Upgrade: 'websocket', Origin: ORIGIN },
    });

    expect(response.status).toBe(401);
    expect((await request('/v1/socket')).status).toBe(426);
    expect((await requestJson('POST', '/v1/socket/ticket', { origin: ORIGIN })).status).toBe(401);
    expect((await requestJson('GET', '/v1/locks', { origin: ORIGIN })).status).toBe(401);
  });

  test('refuse a page on another site', async () => {
    const response = await request('/v1/socket?ticket=nope', {
      headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
    });

    expect(response.status).toBe(403);
  });
});
