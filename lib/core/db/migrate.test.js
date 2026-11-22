import { describe, expect, test } from 'vitest';

import { getTestDatabase } from '../../test/helpers.js';

import { migrate } from './migrate.js';

const db = getTestDatabase('migrate');

const migrations = [
  { version: 1, name: 'one', statements: ['CREATE TABLE one (id INTEGER PRIMARY KEY)'] },
  { version: 2, name: 'two', statements: ['CREATE TABLE two (id INTEGER PRIMARY KEY)'] },
];

describe('migrate()', () => {
  test('applies pending migrations once, in order', async () => {
    await expect(migrate(db, migrations.slice(0, 1))).resolves.toBe(1);
    await expect(migrate(db, migrations)).resolves.toBe(2);
    await expect(migrate(db, migrations)).resolves.toBe(2);

    const versions = await db.all('SELECT version, name FROM schema_version ORDER BY version');

    expect(versions).toEqual([
      { version: 1, name: 'one' },
      { version: 2, name: 'two' },
    ]);
  });

  test('applies nothing of a migration that fails', async () => {
    const broken = {
      version: 3,
      name: 'broken',
      statements: ['CREATE TABLE three (id INTEGER PRIMARY KEY)', 'NOT SQL'],
    };

    await expect(migrate(db, [...migrations, broken])).rejects.toThrow();
    await expect(
      db.first("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'three'"),
    ).resolves.toBeNull();
    await expect(migrate(db, migrations)).resolves.toBe(2);
  });
});
