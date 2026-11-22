import { decryptValue, encryptValue } from './crypto/data-key.js';
import { addSetting, getSettingRow, putSetting } from './store/settings.js';

/**
 * @import { Database, DataKeys } from '../types.js';
 */

/**
 * Get the AAD that binds an encrypted setting to its key.
 * @param {string} key Setting key.
 * @returns {string} AAD.
 */
const getAad = (key) => `setting:ciphertext:${key}`;

/**
 * Get a plain setting.
 * @template T
 * @param {Database} db Database.
 * @param {string} key Setting key.
 * @returns {Promise<T | undefined>} Parsed value, or `undefined` if it isn’t set.
 */
export const getSetting = async (db, key) => {
  const row = await getSettingRow(db, key);

  return typeof row?.value === 'string' ? JSON.parse(row.value) : undefined;
};

/**
 * Set a plain setting.
 * @param {Database} db Database.
 * @param {string} key Setting key.
 * @param {any} value Value, serialized as JSON.
 * @param {object} [options] Options.
 * @param {string | null} [options.actorId] ID of the user making the change, if any.
 * @returns {Promise<void>}
 */
export const setSetting = async (db, key, value, { actorId = null } = {}) => {
  await putSetting(db, {
    key,
    value: JSON.stringify(value),
    ciphertext: null,
    updated_by: actorId,
    updated_at: Date.now(),
  });
};

/**
 * Set a plain setting unless it’s already set, and return the value in effect. Safe to call from
 * concurrent requests: the first one wins.
 * @template T
 * @param {Database} db Database.
 * @param {string} key Setting key.
 * @param {() => T} createValue Function that creates the initial value.
 * @returns {Promise<T>} Value in effect.
 */
export const getOrCreateSetting = async (db, key, createValue) => {
  const existing = await getSetting(db, key);

  if (existing !== undefined) {
    return /** @type {T} */ (existing);
  }

  await addSetting(db, {
    key,
    value: JSON.stringify(createValue()),
    ciphertext: null,
    updated_by: null,
    updated_at: Date.now(),
  });

  return /** @type {T} */ (await getSetting(db, key));
};

/**
 * Get a secret setting, decrypted with the data key.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} key Setting key.
 * @returns {Promise<string | undefined>} Value, or `undefined` if it isn’t set or can’t be
 * decrypted.
 */
export const getSecretSetting = async (db, keys, key) => {
  const row = await getSettingRow(db, key);

  if (typeof row?.ciphertext !== 'string') {
    return undefined;
  }

  return (await decryptValue(keys, row.ciphertext, getAad(key))) ?? undefined;
};

/**
 * Set a secret setting, encrypted with the data key.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} key Setting key.
 * @param {string} value Value.
 * @param {object} [options] Options.
 * @param {string | null} [options.actorId] ID of the user making the change, if any.
 * @returns {Promise<void>}
 */
export const setSecretSetting = async (db, keys, key, value, { actorId = null } = {}) => {
  await putSetting(db, {
    key,
    value: null,
    ciphertext: await encryptValue(keys, value, getAad(key)),
    updated_by: actorId,
    updated_at: Date.now(),
  });
};

/**
 * Get the random ID of the site, created on first use. It salts the password derivation, and
 * tells the GitHub Apps of several sites apart.
 * @param {Database} db Database.
 * @returns {Promise<string>} Site ID.
 */
export const getSiteId = (db) => getOrCreateSetting(db, 'site_id', () => crypto.randomUUID());
