/**
 * Encode bytes as base64url without padding.
 * @param {ArrayBuffer | Uint8Array} bytes Bytes.
 * @returns {string} Encoded string.
 */
export const toBase64Url = (bytes) =>
  (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toBase64({
    alphabet: 'base64url',
    omitPadding: true,
  });

/**
 * Decode a base64url string, with or without padding.
 * @param {string} str Encoded string.
 * @returns {Uint8Array} Bytes.
 * @throws {SyntaxError} If the string isn’t valid base64url.
 */
export const fromBase64Url = (str) => Uint8Array.fromBase64(str, { alphabet: 'base64url' });

/**
 * Encode a string as UTF-8 bytes.
 * @param {string} str String.
 * @returns {Uint8Array} Bytes.
 */
export const toUtf8 = (str) => new TextEncoder().encode(str);

/**
 * Generate cryptographically random bytes.
 * @param {number} length Number of bytes.
 * @returns {Uint8Array} Bytes.
 */
export const getRandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));
