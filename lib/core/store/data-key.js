/**
 * Storage of the data key (`data_key`), wrapped with a key derived from the admin secret. There is
 * only ever one row, with the ID `1`.
 * @import { Database } from '../../types.js';
 */

/**
 * The data key, as stored.
 * @typedef {object} DataKeyRow
 * @property {number} version Version, incremented at every re-key.
 * @property {string} wrapped Key, wrapped.
 */

/**
 * Get the data key.
 * @param {Database} db Database.
 * @returns {Promise<DataKeyRow | undefined>} Row, if the key exists.
 */
export const getDataKeyRow = (db) =>
  db.selectFrom('data_key').select(['version', 'wrapped']).where('id', '=', 1).executeTakeFirst();

/**
 * Store the data key, replacing any existing one.
 * @param {Database} db Database.
 * @param {DataKeyRow} key Key.
 * @returns {Promise<void>}
 */
export const putDataKey = async (db, { version, wrapped }) => {
  const now = Date.now();

  await db
    .insertInto('data_key')
    .values({ id: 1, version, wrapped, created_at: now, updated_at: now })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet((eb) => ({
        version: eb.ref('excluded.version'),
        wrapped: eb.ref('excluded.wrapped'),
        created_at: eb.ref('excluded.created_at'),
        updated_at: eb.ref('excluded.updated_at'),
      })),
    )
    .execute();
};

/**
 * Store the first data key, unless another request has done so in the meantime.
 * @param {Database} db Database.
 * @param {string} wrapped Key, wrapped.
 * @returns {Promise<void>}
 */
export const addFirstDataKey = async (db, wrapped) => {
  const now = Date.now();

  await db
    .insertInto('data_key')
    .values({ id: 1, version: 1, wrapped, created_at: now, updated_at: now })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
};

/**
 * Replace the wrapped data key, if it’s still the given version.
 * @param {Database} db Database.
 * @param {DataKeyRow} key Key.
 * @returns {Promise<boolean>} Whether it was replaced, `false` if it’s another version by now.
 */
export const updateWrappedDataKey = async (db, { version, wrapped }) =>
  Number(
    (
      await db
        .updateTable('data_key')
        .set({ wrapped, updated_at: Date.now() })
        .where('id', '=', 1)
        .where('version', '=', version)
        .executeTakeFirst()
    ).numUpdatedRows,
  ) > 0;
