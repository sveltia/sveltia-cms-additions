import { describe, expect, test } from 'vitest';

import { migrations } from '../../../migrations/index.js';
import { getTestDatabase } from '../../test/helpers.js';

import { migrate } from './migrate.js';

const db = getTestDatabase('provider-accounts-migration');

describe('the provider-accounts migration', () => {
  test('moves the GitHub accounts, keeping their tokens and their link to the user', async () => {
    await migrate(
      db,
      migrations.filter(({ version }) => version < 9),
    );

    await db.batch([
      {
        sql:
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) ' +
          'VALUES (?, ?, ?, 0, ?, ?)',
        params: ['u1', 'Ada', 'ada@example.com', '2026-01-01', '2026-01-01'],
      },
      {
        sql:
          'INSERT INTO github_account (user_id, github_id, login, refresh_token_ciphertext, ' +
          'refresh_token_expires_at, created_at, first_signed_in_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: ['u1', '42', 'ada', 'ciphertext', 2, 1, 3],
      },
    ]);

    await expect(
      migrate(
        db,
        migrations.filter(({ version }) => version <= 9),
      ),
    ).resolves.toBe(9);
    await expect(db.first('SELECT * FROM provider_account')).resolves.toEqual({
      user_id: 'u1',
      provider: 'github',
      external_id: '42',
      login: 'ada',
      refresh_token_ciphertext: 'ciphertext',
      refresh_token_expires_at: 2,
      created_at: 1,
      first_signed_in_at: 3,
    });
    await expect(
      db.first("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'github_account'"),
    ).resolves.toBeNull();

    // The foreign key still holds
    await db.run('DELETE FROM "user" WHERE id = ?', ['u1']);
    await expect(db.first('SELECT * FROM provider_account')).resolves.toBeNull();
  });
});
