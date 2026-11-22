import { HttpError } from './http/errors.js';
import { getSecretSetting, setSecretSetting } from './settings.js';

/**
 * @import { Database, DataKeys } from '../types.js';
 */

/**
 * Credentials an admin shares with everyone who uses the CMS: API keys of the services the CMS
 * calls from the browser, e.g. translators, cloud storage and stock photos, and the deploy hook.
 * Every signed-in user gets them, and the CMS uses a user’s own instead, if they’ve entered one.
 * @typedef {object} Credentials
 * @property {Record<string, string>} api_keys API keys by service ID, e.g. `deepl`.
 * @property {{ url: string, auth_header: string } | null} deploy_hook Deploy hook, with the
 * `Authorization` header to send with it, if any.
 */

/**
 * Key of the secret setting holding the credentials.
 */
export const CREDENTIALS_SETTING = 'credentials';

/**
 * Most API keys that can be stored, which is far more than the services the CMS supports.
 */
export const MAX_API_KEYS = 100;

/**
 * Longest value accepted, e.g. an Azure SAS token.
 */
export const MAX_VALUE_LENGTH = 4096;

/**
 * Service ID, as the CMS names its services, e.g. `deepl` or `cloudflare-r2`.
 */
const SERVICE_ID_REGEX = /^[a-z0-9][\w-]{0,63}$/i;

/**
 * No credentials at all.
 * @type {Credentials}
 */
const EMPTY = { api_keys: {}, deploy_hook: null };

/**
 * Throw an error for invalid credentials.
 * @param {string} message Message.
 * @returns {never} Never returns.
 * @throws {HttpError} Always.
 */
const invalid = (message) => {
  throw new HttpError(400, 'invalid_credentials', message);
};

/**
 * Control characters, line breaks included.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_REGEX = /[\x00-\x1f\x7f]/;

/**
 * Check a value: a string of reasonable length, without line breaks or other control characters,
 * which would break a header.
 * @param {unknown} value Value.
 * @param {string} name Name for the error message.
 * @returns {string} Trimmed value.
 */
const validateValue = (value, name) => {
  if (
    typeof value !== 'string' ||
    value.length > MAX_VALUE_LENGTH ||
    CONTROL_CHARACTER_REGEX.test(value)
  ) {
    invalid(`${name} must be a single line of up to ${MAX_VALUE_LENGTH} characters.`);
  }

  return value.trim();
};

/**
 * Check the credentials an admin sends. Empty values are dropped, so a key is removed by sending
 * an empty string or leaving it out.
 * @param {unknown} input Input.
 * @returns {Credentials} Credentials to store.
 * @throws {HttpError} If they’re malformed.
 */
export const validateCredentials = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    invalid('The credentials must be an object.');
  }

  const { api_keys: apiKeys = {}, deploy_hook: deployHook = null } =
    /** @type {Record<string, any>} */ (input);

  if (!apiKeys || typeof apiKeys !== 'object' || Array.isArray(apiKeys)) {
    invalid('`api_keys` must be an object.');
  }

  const entries = Object.entries(apiKeys);

  if (entries.length > MAX_API_KEYS) {
    invalid(`There can be up to ${MAX_API_KEYS} API keys.`);
  }

  /** @type {Record<string, string>} */
  const validKeys = {};

  entries.forEach(([serviceId, value]) => {
    if (!SERVICE_ID_REGEX.test(serviceId)) {
      invalid(`“${serviceId.slice(0, 64)}” is not a service ID.`);
    }

    const key = validateValue(value, `The API key for ${serviceId}`);

    if (key) {
      validKeys[serviceId] = key;
    }
  });

  if (deployHook === null) {
    return { api_keys: validKeys, deploy_hook: null };
  }

  if (typeof deployHook !== 'object' || Array.isArray(deployHook)) {
    invalid('`deploy_hook` must be an object or `null`.');
  }

  const url = validateValue(deployHook.url ?? '', 'The deploy hook URL');
  const authHeader = validateValue(deployHook.auth_header ?? '', 'The deploy hook header');

  if (!url) {
    return { api_keys: validKeys, deploy_hook: null };
  }

  if (!URL.canParse(url) || new URL(url).protocol !== 'https:') {
    invalid('The deploy hook URL must start with `https://`.');
  }

  return { api_keys: validKeys, deploy_hook: { url, auth_header: authHeader } };
};

/**
 * Get the stored credentials.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @returns {Promise<Credentials>} Credentials, empty if none are stored, or if they were lost with
 * the data key.
 */
export const getCredentials = async (db, keys) => {
  const value = await getSecretSetting(db, keys, CREDENTIALS_SETTING);

  if (!value) {
    return structuredClone(EMPTY);
  }

  const { api_keys: apiKeys = {}, deploy_hook: deployHook = null } = JSON.parse(value);

  return { api_keys: apiKeys, deploy_hook: deployHook };
};

/**
 * Store the credentials, replacing those stored before.
 * @param {Database} db Database.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {Credentials} credentials Validated credentials.
 * @param {object} options Options.
 * @param {string} options.actorId ID of the admin making the change.
 * @returns {Promise<void>}
 */
export const setCredentials = async (db, keys, credentials, { actorId }) => {
  await setSecretSetting(db, keys, CREDENTIALS_SETTING, JSON.stringify(credentials), { actorId });
};
