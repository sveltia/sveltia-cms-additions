import { timingSafeEqualStrings } from '../crypto/compare.js';
import { getRandomBytes, toBase64Url, toUtf8 } from '../crypto/encoding.js';

/**
 * A prehash: 256 bits of PBKDF2 output as base64url without padding, which is always 43 characters.
 */
export const PREHASH_REGEX = /^[\w-]{43}$/;

/**
 * Length of a prehash, used as both the minimum and maximum “password” length in Better Auth.
 */
export const PREHASH_LENGTH = 43;

/**
 * Hash a prehash with a random salt. The browser has already done the slow work (PBKDF2 with
 * 600,000 iterations), so a single SHA-256 is enough here and fits the Workers Free plan’s CPU
 * limit. The salt stops identical passwords from producing identical hashes.
 * @param {string} prehash Prehash sent by the browser.
 * @param {string} [salt] Salt, as base64url. A new one is generated when omitted.
 * @returns {Promise<string>} `v1$<salt>$<hash>`.
 */
export const hashPrehash = async (prehash, salt = toBase64Url(getRandomBytes(16))) => {
  const digest = await crypto.subtle.digest('SHA-256', toUtf8(`${salt}$${prehash}`));

  return `v1$${salt}$${toBase64Url(digest)}`;
};

/**
 * Verify a prehash against a hash created with {@link hashPrehash}.
 * @param {object} args Arguments.
 * @param {string} args.hash Stored hash.
 * @param {string} args.password Prehash sent by the browser.
 * @returns {Promise<boolean>} Whether they match.
 */
export const verifyPrehash = async ({ hash, password }) => {
  const [version, salt] = hash.split('$');

  if (version !== 'v1' || !salt) {
    return false;
  }

  return timingSafeEqualStrings(await hashPrehash(password, salt), hash);
};
