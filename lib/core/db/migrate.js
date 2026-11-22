/**
 * @import { Migration, SqlRunner } from '../../types.js';
 */

/**
 * Apply the migrations newer than the database’s schema version. Each migration runs in a single
 * batch together with its version record, so it’s applied entirely or not at all. The caller must
 * make sure only one migration run happens at a time.
 * @param {SqlRunner} db Database.
 * @param {Migration[]} migrations All migrations, in ascending version order.
 * @returns {Promise<number>} Schema version after the run.
 */
export const migrate = async (db, migrations) => {
  await db.run(
    'CREATE TABLE IF NOT EXISTS schema_version ' +
      '(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );

  const row = await db.first('SELECT MAX(version) AS version FROM schema_version');
  const current = /** @type {number | null} */ (row?.version) ?? 0;
  const pending = migrations.filter(({ version }) => version > current);

  // Run the migrations one after another
  await pending.reduce(async (previous, { version, name, statements }) => {
    await previous;
    await db.batch([
      ...statements.map((sql) => ({ sql })),
      {
        sql: 'INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)',
        params: [version, name, new Date().toISOString()],
      },
    ]);
  }, Promise.resolve());

  return pending.at(-1)?.version ?? current;
};
