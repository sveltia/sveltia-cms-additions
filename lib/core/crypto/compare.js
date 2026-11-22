import { toUtf8 } from './encoding.js';

/**
 * Compare two strings in constant time. Both are hashed first, so the comparison takes the same
 * time whatever their lengths, and the runtime’s own `timingSafeEqual`, which throws on a length
 * mismatch and only exists on Workers, isn’t needed.
 * @param {string} a First string.
 * @param {string} b Second string.
 * @returns {Promise<boolean>} Whether the strings are equal.
 */
export const timingSafeEqualStrings = async (a, b) => {
  const [digestA, digestB] = await Promise.all(
    [a, b].map(async (str) => new Uint8Array(await crypto.subtle.digest('SHA-256', toUtf8(str)))),
  );

  // Accumulate the differences of every byte rather than returning at the first one
  // eslint-disable-next-line no-bitwise
  return digestA.reduce((diff, byte, index) => diff | (byte ^ digestB[index]), 0) === 0;
};
