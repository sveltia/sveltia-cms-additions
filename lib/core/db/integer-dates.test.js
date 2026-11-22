import { describe, expect, test } from 'vitest';

import { migrations } from '../../../migrations/index.js';
import { getTestDatabase } from '../../test/helpers.js';

import { migrate } from './migrate.js';

const db = getTestDatabase('integer-dates');

describe('the integer-dates migration', () => {
  test('converts the dates stored as ISO 8601 strings, keeping the rows', async () => {
    await migrate(
      db,
      migrations.filter(({ version }) => version < 7),
    );

    await db.batch([
      {
        sql:
          'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) ' +
          'VALUES (?, ?, ?, 0, ?, ?)',
        params: [
          'u1',
          'Ada',
          'ada@example.com',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      },
      {
        sql:
          'INSERT INTO comment (id, entry_key, user_id, body, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?)',
        params: [
          'c1',
          'posts/hi',
          'u1',
          'Hello',
          '2026-01-02T03:04:05.678Z',
          '2026-01-02T03:04:06.000Z',
        ],
      },
      {
        sql: 'INSERT INTO github_account (user_id, github_id, login, created_at) VALUES (?, ?, ?, ?)',
        params: ['u1', '1', 'ada', '2026-01-01T00:00:00.000Z'],
      },
      {
        sql: 'INSERT INTO audit_log (at, action) VALUES (?, ?)',
        params: ['2026-01-01T00:00:00.000Z', 'auth.sign_in'],
      },
    ]);

    await expect(
      migrate(
        db,
        migrations.filter(({ version }) => version <= 7),
      ),
    ).resolves.toBe(7);

    await expect(db.first('SELECT * FROM comment')).resolves.toEqual({
      id: 'c1',
      entry_key: 'posts/hi',
      user_id: 'u1',
      body: 'Hello',
      created_at: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
      updated_at: Date.UTC(2026, 0, 2, 3, 4, 6),
    });
    await expect(db.first('SELECT * FROM github_account')).resolves.toMatchObject({
      created_at: Date.UTC(2026, 0, 1),
      refresh_token_expires_at: null,
      first_signed_in_at: null,
    });
    await expect(db.first('SELECT id, at FROM audit_log')).resolves.toEqual({
      id: 1,
      at: Date.UTC(2026, 0, 1),
    });
    // The foreign key still holds
    await db.run('DELETE FROM "user" WHERE id = ?', ['u1']);
    await expect(db.first('SELECT user_id FROM comment')).resolves.toEqual({ user_id: null });
    await expect(db.first('SELECT * FROM github_account')).resolves.toBeNull();
  });
});
