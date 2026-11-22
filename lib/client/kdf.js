/**
 * Reference implementation of the password derivation that runs in the browser, version `v1`. The
 * CMS has its own copy, and both are tested against `docs/kdf-test-vectors.json`.
 */

/**
 * PBKDF2 iterations, OWASP’s recommendation for PBKDF2-HMAC-SHA-256.
 */
export const KDF_ITERATIONS = 600_000;

/**
 * Derive the salt for a user. It’s deterministic, so signing in needs no extra request.
 * @param {string} siteId Site ID from `/version`.
 * @param {string} username Username. It’s lower-cased.
 * @returns {Promise<ArrayBuffer>} Salt.
 */
export const deriveSalt = (siteId, username) =>
  crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`sveltia-cms-additions:${siteId}:${username.toLowerCase()}`),
  );

/**
 * Derive the prehash sent to the server in place of the password.
 * @param {object} args Arguments.
 * @param {string} args.siteId Site ID from `/version`.
 * @param {string} args.username Username.
 * @param {string} args.password Password, exactly as typed.
 * @param {number} [args.iterations] PBKDF2 iterations. Only tests change it.
 * @returns {Promise<string>} 256 bits as base64url without padding: always 43 characters.
 */
export const derivePrehash = async ({
  siteId,
  username,
  password,
  iterations = KDF_ITERATIONS,
}) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: await deriveSalt(siteId, username), iterations },
    key,
    256,
  );

  return new Uint8Array(bits).toBase64({ alphabet: 'base64url', omitPadding: true });
};
