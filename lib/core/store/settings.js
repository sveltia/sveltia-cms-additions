/**
 * Storage of the settings managed in the CMS (`setting`). A secret setting is stored encrypted in
 * `ciphertext`, with `value` left `NULL`; encryption is done in `../settings.js`.
 * @import { Database } from '../../types.js';
 */

/**
 * A setting, as stored.
 * @typedef {object} SettingRow
 * @property {string} key Key.
 * @property {string | null} value Plain value, as JSON.
 * @property {string | null} ciphertext Secret value, encrypted.
 * @property {string | null} updated_by ID of the user who last changed it.
 * @property {number} updated_at Date of the last change.
 */

/**
 * Get a setting.
 * @param {Database} db Database.
 * @param {string} key Key.
 * @returns {Promise<Pick<SettingRow, 'value' | 'ciphertext'> | undefined>} Row, if set.
 */
export const getSettingRow = (db, key) =>
  db
    .selectFrom('setting')
    .select(['value', 'ciphertext'])
    .where('key', '=', key)
    .executeTakeFirst();

/**
 * Store a setting, replacing it if it’s already set.
 * @param {Database} db Database.
 * @param {SettingRow} row Setting.
 * @returns {Promise<void>}
 */
export const putSetting = async (db, row) => {
  await db
    .insertInto('setting')
    .values(row)
    .onConflict((oc) =>
      oc.column('key').doUpdateSet((eb) => ({
        value: eb.ref('excluded.value'),
        ciphertext: eb.ref('excluded.ciphertext'),
        updated_by: eb.ref('excluded.updated_by'),
        updated_at: eb.ref('excluded.updated_at'),
      })),
    )
    .execute();
};

/**
 * Store a setting unless it’s already set, in one statement, so concurrent requests can’t both
 * set it.
 * @param {Database} db Database.
 * @param {SettingRow} row Setting.
 * @returns {Promise<void>}
 */
export const addSetting = async (db, row) => {
  await db
    .insertInto('setting')
    .values(row)
    .onConflict((oc) => oc.column('key').doNothing())
    .execute();
};

/**
 * Delete every secret setting.
 * @param {Database} db Database.
 * @returns {Promise<string[]>} Keys of the deleted settings.
 */
export const deleteSecretSettingRows = async (db) =>
  (
    await db.deleteFrom('setting').where('ciphertext', 'is not', null).returning('key').execute()
  ).map(({ key }) => key);

/**
 * Delete settings.
 * @param {Database} db Database.
 * @param {string[]} keys Keys.
 * @returns {Promise<void>}
 */
export const deleteSettings = async (db, keys) => {
  await db.deleteFrom('setting').where('key', 'in', keys).execute();
};
