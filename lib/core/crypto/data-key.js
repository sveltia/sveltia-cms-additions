import { HttpError } from '../http/errors.js';
import {
  addFirstDataKey,
  getDataKeyRow,
  putDataKey,
  updateWrappedDataKey,
} from '../store/data-key.js';

import { fromBase64Url, getRandomBytes, toBase64Url, toUtf8 } from './encoding.js';

/**
 * @import { Database, DataKeys, DataKeyState } from '../../types.js';
 * @import { DataKeyRow } from '../store/data-key.js';
 */

/**
 * How long derived keys are cached in an isolate. A re-key in another isolate takes effect here
 * within this time.
 */
const CACHE_TTL = 60 * 1000;

/**
 * HKDF salt shared by every derivation. Keys are separated by their `info` strings.
 */
const HKDF_SALT = toUtf8('sveltia-cms-additions');

/**
 * Cached keys, by database and wrapping secret: every tenant has its own data key, and several
 * tenants can share an isolate.
 * @type {WeakMap<Database, { cacheKey: string, state: DataKeyState, expires: number }>}
 */
let caches = new WeakMap();

/**
 * Clear the cached keys. Called after the data key changes, and by tests.
 * @param {Database} [db] Database whose keys to clear. Default: every database’s.
 */
export const clearDataKeyCache = (db) => {
  if (db) {
    caches.delete(db);
  } else {
    caches = new WeakMap();
  }
};

/**
 * Import key material for HKDF.
 * @param {Uint8Array} material Key material.
 * @returns {Promise<CryptoKey>} HKDF key.
 */
const importHkdfKey = (material) =>
  crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveKey', 'deriveBits']);

/**
 * Derive an AES-GCM key with HKDF-SHA-256.
 * @param {CryptoKey} baseKey HKDF key.
 * @param {string} info Purpose of the key.
 * @returns {Promise<CryptoKey>} AES-GCM key.
 */
const deriveAesKey = (baseKey, info) =>
  crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: toUtf8(info) },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

/**
 * Derive the key-encryption key that wraps the data key, from `ADMIN_SECRET`.
 * @param {string} secret Admin secret.
 * @returns {Promise<CryptoKey>} AES-GCM key.
 */
const deriveWrappingKey = async (secret) =>
  deriveAesKey(await importHkdfKey(toUtf8(secret)), 'data key wrapping v1');

/**
 * Encrypt bytes with AES-GCM under a random 96-bit IV.
 * @param {CryptoKey} key AES-GCM key.
 * @param {Uint8Array} plaintext Bytes to encrypt.
 * @param {string} aad Additional authenticated data, binding the ciphertext to where it’s stored.
 * @returns {Promise<string>} `<iv>.<ciphertext>`, both base64url.
 */
const seal = async (key, plaintext, aad) => {
  const iv = getRandomBytes(12);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: toUtf8(aad) },
    key,
    plaintext,
  );

  return `${toBase64Url(iv)}.${toBase64Url(ciphertext)}`;
};

/**
 * Decrypt a value produced by {@link seal}.
 * @param {CryptoKey} key AES-GCM key.
 * @param {string} sealed `<iv>.<ciphertext>`.
 * @param {string} aad Additional authenticated data used when sealing.
 * @returns {Promise<Uint8Array | null>} Bytes, or `null` if the key, the AAD or the data is wrong.
 */
const open = async (key, sealed, aad) => {
  const [iv, ciphertext] = sealed.split('.');

  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64Url(iv), additionalData: toUtf8(aad) },
        key,
        fromBase64Url(ciphertext),
      ),
    );
  } catch {
    return null;
  }
};

/**
 * Get the AAD for the wrapped data key of the given version.
 * @param {number} version Data key version.
 * @returns {string} AAD.
 */
const getWrapAad = (version) => `data_key:wrapped:${version}`;

/**
 * Derive the working keys from the raw data key.
 * @param {Uint8Array} dataKey Raw data key.
 * @param {number} version Data key version.
 * @returns {Promise<DataKeys>} Keys.
 */
const deriveKeys = async (dataKey, version) => {
  const baseKey = await importHkdfKey(dataKey);

  const signingBits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info: toUtf8('session signing v1') },
    baseKey,
    256,
  );

  return {
    version,
    encryptionKey: await deriveAesKey(baseKey, 'value encryption v1'),
    signingSecret: toBase64Url(signingBits),
  };
};

/**
 * Generate a new data key, wrap it with the admin secret and store it, replacing any existing one.
 * @param {Database} db Database.
 * @param {string} secret Admin secret.
 * @param {number} version Version of the new key.
 * @returns {Promise<void>}
 */
const storeNewDataKey = async (db, secret, version) => {
  const wrapped = await seal(
    await deriveWrappingKey(secret),
    getRandomBytes(32),
    getWrapAad(version),
  );

  await putDataKey(db, { version, wrapped });
};

/**
 * Get the keys derived from the data key, unwrapping it with the admin secret. On the very first
 * call, a data key is generated. If the admin secret was replaced without re-wrapping the data key,
 * the key is reported as locked until it’s re-wrapped with the previous secret or re-keyed.
 * @param {Database} db Database.
 * @param {string} secret Admin secret.
 * @returns {Promise<DataKeyState>} State, with the keys if unlocked.
 */
export const getDataKeys = async (db, secret) => {
  const cacheKey = toBase64Url(await crypto.subtle.digest('SHA-256', toUtf8(secret)));

  const cache = caches.get(db);

  if (cache && cache.cacheKey === cacheKey && cache.expires > Date.now()) {
    return cache.state;
  }

  let row = await getDataKeyRow(db);

  if (!row) {
    // Insert only if another request hasn’t done so in the meantime
    const wrapped = await seal(await deriveWrappingKey(secret), getRandomBytes(32), getWrapAad(1));

    await addFirstDataKey(db, wrapped);

    row = /** @type {DataKeyRow} */ (await getDataKeyRow(db));
  }

  const dataKey = await open(await deriveWrappingKey(secret), row.wrapped, getWrapAad(row.version));

  /** @type {DataKeyState} */
  const state = dataKey
    ? { status: 'ok', keys: await deriveKeys(dataKey, row.version) }
    : { status: 'locked' };

  caches.set(db, { cacheKey, state, expires: Date.now() + CACHE_TTL });

  return state;
};

/**
 * Re-wrap the data key with a new admin secret, after the secret was changed in the platform’s
 * settings. Nothing else changes.
 * @param {Database} db Database.
 * @param {object} args Arguments.
 * @param {string} args.previousSecret Admin secret the data key is currently wrapped with.
 * @param {string} args.secret New admin secret.
 * @returns {Promise<void>}
 * @throws {HttpError} If there is no data key, or the previous secret is wrong.
 */
export const rewrapDataKey = async (db, { previousSecret, secret }) => {
  const row = await getDataKeyRow(db);

  if (!row) {
    throw new HttpError(409, 'no_data_key', 'There is no data key to re-wrap.');
  }

  const aad = getWrapAad(row.version);
  const dataKey = await open(await deriveWrappingKey(previousSecret), row.wrapped, aad);

  if (!dataKey) {
    throw new HttpError(400, 'wrong_previous_secret', 'The previous admin secret is wrong.');
  }

  const updated = await updateWrappedDataKey(db, {
    version: row.version,
    wrapped: await seal(await deriveWrappingKey(secret), dataKey, aad),
  });

  // Re-keyed meanwhile, which a request on another instance could do
  if (!updated) {
    throw new HttpError(409, 'data_key_changed', 'The data key has just changed. Try again.');
  }

  clearDataKeyCache(db);
};

/**
 * Replace the data key with a new one after the previous admin secret was lost. Everything
 * encrypted with the old key becomes unreadable, so the caller deletes it.
 * @param {Database} db Database.
 * @param {string} secret Current admin secret.
 * @returns {Promise<number>} Version of the new data key.
 */
export const rekeyDataKey = async (db, secret) => {
  const row = await getDataKeyRow(db);
  const version = (row?.version ?? 0) + 1;

  await storeNewDataKey(db, secret, version);
  clearDataKeyCache(db);

  return version;
};

/**
 * Encrypt a string with the data key.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} plaintext String to encrypt.
 * @param {string} aad Where the value is stored, e.g. `table:column:row id`.
 * @returns {Promise<string>} `<key version>.<iv>.<ciphertext>`.
 */
export const encryptValue = async (keys, plaintext, aad) =>
  `${keys.version}.${await seal(keys.encryptionKey, toUtf8(plaintext), aad)}`;

/**
 * Decrypt a string encrypted with {@link encryptValue}.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} encrypted Encrypted value.
 * @param {string} aad AAD used when encrypting.
 * @returns {Promise<string | null>} String, or `null` if it was encrypted with another data key,
 * stored elsewhere or tampered with.
 */
export const decryptValue = async (keys, encrypted, aad) => {
  const [version, ...sealed] = encrypted.split('.');

  if (Number(version) !== keys.version) {
    return null;
  }

  const plaintext = await open(keys.encryptionKey, sealed.join('.'), aad);

  return plaintext ? new TextDecoder().decode(plaintext) : null;
};
