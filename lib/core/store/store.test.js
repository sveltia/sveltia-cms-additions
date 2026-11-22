import { beforeAll, describe, expect, test } from 'vitest';

import { migrations } from '../../../migrations/index.js';
import { getTestDatabase } from '../../test/helpers.js';
import { changeUserAccess, deleteUser } from '../auth/users.js';
import { renameComments } from '../comments.js';
import { migrate } from '../db/migrate.js';

import { insertCommentIfRoom, moveCommentRows } from './comments.js';
import { insertFlow, takeFlowRow } from './flows.js';
import { findProviderAccountRow, replaceProviderAccount } from './provider-accounts.js';
import {
  countActiveAdminRows,
  deleteUserUnlessLastAdmin,
  updateUserAccessUnlessLastAdmin,
} from './users.js';

const db = getTestDatabase('store');

/**
 * Add a user.
 * @param {string} id ID.
 * @param {string | null} role Role.
 * @returns {Promise<void>}
 */
const addUser = async (id, role) => {
  const now = new Date().toISOString();

  await db
    .insertInto('user')
    .values({
      id,
      name: id,
      email: `${id}@example.com`,
      emailVerified: 0,
      createdAt: now,
      updatedAt: now,
      role,
    })
    .execute();
};

beforeAll(async () => {
  await migrate(db, migrations);
  await addUser('admin', 'admin');
  await addUser('editor', 'editor');
});

describe('users', () => {
  test('keeps the last admin who can sign in', async () => {
    await expect(updateUserAccessUnlessLastAdmin(db, 'admin', { role: 'editor' })).resolves.toBe(
      false,
    );
    await expect(updateUserAccessUnlessLastAdmin(db, 'admin', { banned: true })).resolves.toBe(
      false,
    );
    await expect(deleteUserUnlessLastAdmin(db, 'admin')).resolves.toBe(false);
    // Changes that leave them an admin go through
    await expect(updateUserAccessUnlessLastAdmin(db, 'admin', { role: 'admin' })).resolves.toBe(
      true,
    );
    await expect(updateUserAccessUnlessLastAdmin(db, 'admin', { banned: false })).resolves.toBe(
      true,
    );
    // Anyone else can be changed
    await expect(updateUserAccessUnlessLastAdmin(db, 'editor', { banned: true })).resolves.toBe(
      true,
    );
    await expect(updateUserAccessUnlessLastAdmin(db, 'editor', { banned: false })).resolves.toBe(
      true,
    );
  });

  test('lets an admin go once there is another', async () => {
    await expect(updateUserAccessUnlessLastAdmin(db, 'editor', { role: 'admin' })).resolves.toBe(
      true,
    );
    await expect(updateUserAccessUnlessLastAdmin(db, 'admin', { role: 'editor' })).resolves.toBe(
      true,
    );
    // Now the last one
    await expect(deleteUserUnlessLastAdmin(db, 'editor')).resolves.toBe(false);
    await expect(deleteUserUnlessLastAdmin(db, 'admin')).resolves.toBe(true);
    await expect(deleteUserUnlessLastAdmin(db, 'missing')).resolves.toBe(false);
  });

  test('treats a user without a role as not an admin', async () => {
    await addUser('no-role', null);
    // With a single admin left, the condition decides
    await expect(countActiveAdminRows(db)).resolves.toBe(1);

    await expect(updateUserAccessUnlessLastAdmin(db, 'no-role', { banned: true })).resolves.toBe(
      true,
    );
    await expect(deleteUserUnlessLastAdmin(db, 'no-role')).resolves.toBe(true);
  });

  test('tells a deleted user from the last admin', async () => {
    await expect(changeUserAccess(db, 'missing', { role: 'viewer' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(deleteUser(db, 'missing')).rejects.toMatchObject({ status: 404 });
    await expect(deleteUser(db, 'editor')).rejects.toMatchObject({ status: 409 });
  });
});

describe('comments', () => {
  test('adds comments up to the limit', async () => {
    const add = (id) =>
      insertCommentIfRoom(db, { id, entry_key: 'posts/a', user_id: 'editor', body: 'Hi' }, 2);

    await expect(add('a1')).resolves.toBe(true);
    await expect(add('a2')).resolves.toBe(true);
    await expect(add('a3')).resolves.toBe(false);
  });

  test('moves comments only to a key without any', async () => {
    await insertCommentIfRoom(
      db,
      { id: 'b1', entry_key: 'posts/b', user_id: 'editor', body: 'Hi' },
      10,
    );

    await expect(moveCommentRows(db, 'posts/a', 'posts/b')).resolves.toBe(0);
    await expect(moveCommentRows(db, 'posts/a', 'posts/c')).resolves.toBe(2);
    await expect(moveCommentRows(db, 'posts/a', 'posts/d')).resolves.toBe(0);
  });
});

describe('renaming comments', () => {
  test('moves nothing, without failing, from a key without comments', async () => {
    await insertCommentIfRoom(
      db,
      { id: 'r1', entry_key: 'posts/taken', user_id: 'editor', body: 'Left over' },
      10,
    );

    await expect(renameComments(db, 'posts/none', 'posts/taken')).resolves.toBe(0);
  });
});

describe('flows', () => {
  test('hands a flow out once', async () => {
    await insertFlow(db, {
      state: 's1',
      provider: 'github',
      redirect_uri: 'https://cms.example.com/admin/',
      client_state: 'c',
      code_challenge: 'x',
      link_user_id: null,
      expires_at: Date.now() + 60_000,
    });

    await expect(takeFlowRow(db, 's1')).resolves.toMatchObject({ state: 's1' });
    await expect(takeFlowRow(db, 's1')).resolves.toBeUndefined();
  });
});

describe('GitHub accounts', () => {
  test('keeps the identity a user has if the new one is taken', async () => {
    await addUser('gh1', 'editor');
    await addUser('gh2', 'editor');
    await replaceProviderAccount(db, {
      userId: 'gh1',
      provider: 'github',
      externalId: '1',
      login: 'one',
    });
    await replaceProviderAccount(db, {
      userId: 'gh2',
      provider: 'github',
      externalId: '2',
      login: 'two',
    });

    await expect(
      replaceProviderAccount(db, {
        userId: 'gh1',
        provider: 'github',
        externalId: '2',
        login: 'two',
      }),
    ).rejects.toThrow(/UNIQUE/);
    await expect(findProviderAccountRow(db, 'github', { userId: 'gh1' })).resolves.toMatchObject({
      external_id: '1',
    });

    await replaceProviderAccount(db, {
      userId: 'gh1',
      provider: 'github',
      externalId: '3',
      login: 'three',
    });
    await expect(findProviderAccountRow(db, 'github', { userId: 'gh1' })).resolves.toMatchObject({
      external_id: '3',
      login: 'three',
    });
  });
});
