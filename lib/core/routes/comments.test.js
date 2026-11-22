import { beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ADMIN_SECRET,
  createPrehash,
  db,
  listen,
  requestJson,
  resetState,
  signIn,
} from '../../test/helpers.js';
import { MAX_BODY_LENGTH, PAGE_SIZE } from '../comments.js';

const ORIGIN = 'https://cms.example';
const KEY = 'posts/hello';

/** @type {string} */
let adminToken;

/**
 * Send a request as a user.
 * @param {string} token Session token.
 * @param {string} method Method.
 * @param {string} path Path.
 * @param {Record<string, any>} [body] Body.
 * @returns {Promise<Response>} Response.
 */
const send = (token, method, path, body) =>
  requestJson(method, path, { body, token, origin: ORIGIN });

/**
 * Create a user who has changed their temporary password, and sign them in.
 * @param {string} username Username.
 * @param {string} role Role.
 * @returns {Promise<string>} Session token.
 */
const createSignedInUser = async (username, role) => {
  const temporary = createPrehash();

  await send(adminToken, 'POST', '/v1/users', {
    username,
    name: username.toUpperCase(),
    role,
    prehash: temporary,
  });

  const changed = await requestJson('POST', '/v1/auth/password', {
    body: { current_prehash: temporary, new_prehash: createPrehash() },
    token: await signIn(username, temporary),
  });

  return (await changed.json()).session_token;
};

/**
 * Open a tab’s connection, and collect what it receives.
 * @param {string} token Session token.
 * @returns {Promise<any[]>} Messages received, filled in as they come.
 */
const listenAs = (token) => listen(token, ORIGIN);

/**
 * List an entry’s comments.
 * @param {string} token Session token.
 * @param {string} [query] Query string.
 * @returns {Promise<any>} Response body.
 */
const list = async (token, query = `key=${encodeURIComponent(KEY)}`) =>
  (await send(token, 'GET', `/v1/comments?${query}`)).json();

beforeEach(async () => {
  await resetState();

  const prehash = createPrehash();

  await requestJson('POST', '/v1/setup/admin', {
    body: { username: 'admin', prehash, allow_origin: true },
    token: ADMIN_SECRET,
    origin: ORIGIN,
  });
  adminToken = await signIn('admin', prehash);
});

describe('comments', () => {
  test('are shared by every role, viewers included, and announced to open tabs', async () => {
    const viewerToken = await createSignedInUser('vic', 'viewer');
    const messages = await listenAs(adminToken);

    const created = await send(viewerToken, 'POST', '/v1/comments', {
      key: KEY,
      body: 'Looks good to me.',
    });

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      comment: {
        key: KEY,
        body: 'Looks good to me.',
        author: { name: 'VIC', username: 'vic' },
        can_edit: true,
        can_delete: true,
      },
    });
    await vi.waitFor(() =>
      expect(messages).toContainEqual({ type: 'comments', key: KEY, count: 1 }),
    );

    // Only the author edits; an admin can delete
    const { comments } = await list(adminToken);

    expect(comments[0]).toMatchObject({ can_edit: false, can_delete: true });
    await expect(list(viewerToken)).resolves.toMatchObject({
      comments: [{ can_edit: true }],
      has_more: false,
    });
    await expect((await send(adminToken, 'GET', '/v1/comments/counts')).json()).resolves.toEqual({
      counts: { [KEY]: 1 },
    });
  });

  test('are edited by their author and deleted by them or an admin, which is recorded', async () => {
    const editorToken = await createSignedInUser('eddie', 'editor');
    const otherToken = await createSignedInUser('bobby', 'editor');

    const { comment } = await (
      await send(editorToken, 'POST', '/v1/comments', { key: KEY, body: 'First' })
    ).json();

    expect(
      (await send(otherToken, 'PATCH', `/v1/comments/${comment.id}`, { body: 'X' })).status,
    ).toBe(403);
    expect(
      (await send(adminToken, 'PATCH', `/v1/comments/${comment.id}`, { body: 'X' })).status,
    ).toBe(403);
    expect((await send(otherToken, 'DELETE', `/v1/comments/${comment.id}`)).status).toBe(403);

    const edited = await (
      await send(editorToken, 'PATCH', `/v1/comments/${comment.id}`, { body: 'Edited' })
    ).json();

    expect(edited.comment).toMatchObject({ body: 'Edited' });

    // The author deleting their own comment isn’t worth an audit entry
    const { comment: second } = await (
      await send(editorToken, 'POST', '/v1/comments', { key: KEY, body: 'Second' })
    ).json();

    expect((await send(editorToken, 'DELETE', `/v1/comments/${second.id}`)).status).toBe(200);
    expect((await send(adminToken, 'DELETE', `/v1/comments/${comment.id}`)).status).toBe(200);
    expect((await send(adminToken, 'DELETE', `/v1/comments/${comment.id}`)).status).toBe(404);

    const audits = await db.all("SELECT * FROM audit_log WHERE action = 'comment.delete'");

    expect(audits).toHaveLength(1);
    await expect(list(adminToken)).resolves.toMatchObject({ comments: [] });
  });

  test('keep a deleted user’s comments without an author', async () => {
    const editorToken = await createSignedInUser('eddie', 'editor');

    await send(editorToken, 'POST', '/v1/comments', { key: KEY, body: 'Hello' });

    const { users } = await (await send(adminToken, 'GET', '/v1/users')).json();
    const editor = users.find((/** @type {any} */ { username }) => username === 'eddie');

    await send(adminToken, 'DELETE', `/v1/users/${editor.id}`);

    await expect(list(adminToken)).resolves.toMatchObject({
      comments: [{ body: 'Hello', author: null, can_edit: false, can_delete: true }],
    });
  });

  test('page the oldest ones out', async () => {
    const statements = Array.from({ length: PAGE_SIZE + 2 }, (_, index) => ({
      sql:
        'INSERT INTO comment (id, entry_key, user_id, body, created_at, updated_at) ' +
        'VALUES (?, ?, NULL, ?, ?, ?)',
      params: [
        `c${String(index).padStart(4, '0')}`,
        KEY,
        `Comment ${index}`,
        Date.UTC(2026, 0, 1, 0, 0, index),
        Date.UTC(2026, 0, 1, 0, 0, index),
      ],
    }));

    await db.batch(statements);

    const first = await list(adminToken);

    expect(first.comments).toHaveLength(PAGE_SIZE);
    expect(first.has_more).toBe(true);
    // The newest ones, oldest first
    expect(first.comments[0].body).toBe('Comment 2');
    expect(first.comments.at(-1).body).toBe(`Comment ${PAGE_SIZE + 1}`);

    const older = await list(adminToken, `key=${KEY}&before=${first.comments[0].id}`);

    expect(older).toMatchObject({
      comments: [{ body: 'Comment 0' }, { body: 'Comment 1' }],
      has_more: false,
    });

    // A comment that’s gone, or on another entry, can’t be listed before, rather than giving the
    // newest page again
    const statuses = await Promise.all(
      [`key=${KEY}&before=gone`, `key=other&before=${first.comments[0].id}`].map(
        async (query) => (await send(adminToken, 'GET', `/v1/comments?${query}`)).status,
      ),
    );

    expect(statuses).toEqual([404, 404]);
  });

  test('follow an entry renamed or deleted by an editor', async () => {
    const viewerToken = await createSignedInUser('vic', 'viewer');

    await send(adminToken, 'POST', '/v1/comments', { key: KEY, body: 'Hello' });
    await send(adminToken, 'POST', '/v1/comments', { key: 'posts/other', body: 'Taken' });

    expect(
      (await send(viewerToken, 'POST', '/v1/comments/rename', { from: KEY, to: 'posts/hi' }))
        .status,
    ).toBe(403);
    expect(
      (await send(adminToken, 'POST', '/v1/comments/rename', { from: KEY, to: 'posts/other' }))
        .status,
    ).toBe(409);

    const messages = await listenAs(adminToken);

    await expect(
      (await send(adminToken, 'POST', '/v1/comments/rename', { from: KEY, to: 'posts/hi' })).json(),
    ).resolves.toEqual({ moved: 1 });
    await vi.waitFor(() =>
      expect(messages).toEqual(
        expect.arrayContaining([
          { type: 'comments', key: KEY, count: 0 },
          { type: 'comments', key: 'posts/hi', count: 1 },
        ]),
      ),
    );

    expect((await send(viewerToken, 'DELETE', '/v1/comments?key=posts%2Fhi')).status).toBe(403);
    expect((await send(adminToken, 'DELETE', '/v1/comments?key=posts%2Fhi')).status).toBe(200);
    await expect(list(adminToken, 'key=posts%2Fhi')).resolves.toMatchObject({ comments: [] });
  });

  test('check what they’re sent, and limit how fast they’re written', async () => {
    /**
     * Post a comment.
     * @param {Record<string, any>} body Body.
     * @returns {Promise<number>} Status.
     */
    const post = async (body) => (await send(adminToken, 'POST', '/v1/comments', body)).status;

    expect(await post({ key: '', body: 'x' })).toBe(400);
    expect(await post({ key: 'x'.repeat(513), body: 'x' })).toBe(400);
    expect(await post({ key: KEY, body: '  ' })).toBe(400);
    expect(await post({ key: KEY, body: 'x'.repeat(MAX_BODY_LENGTH + 1) })).toBe(400);
    expect((await send(adminToken, 'GET', '/v1/comments')).status).toBe(400);
    expect((await requestJson('GET', `/v1/comments?key=${KEY}`, { origin: ORIGIN })).status).toBe(
      401,
    );

    const statuses = await Array.from({ length: 31 }).reduce(
      async (previous) => [...(await previous), await post({ key: KEY, body: 'Hi' })],
      Promise.resolve(/** @type {number[]} */ ([])),
    );

    expect(statuses.at(-2)).toBe(201);
    expect(statuses.at(-1)).toBe(429);
  });

  test('stop at a thousand per entry', async () => {
    await db.batch(
      Array.from({ length: 1000 }, (_, index) => ({
        sql:
          'INSERT INTO comment (id, entry_key, user_id, body, created_at, updated_at) ' +
          "VALUES (?, ?, NULL, 'x', '2026-01-01', '2026-01-01')",
        params: [`c${index}`, KEY],
      })),
    );

    expect(
      (await send(adminToken, 'POST', '/v1/comments', { key: KEY, body: 'One more' })).status,
    ).toBe(409);
  });
});
