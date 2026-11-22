/**
 * DER encoding of the rsaEncryption algorithm identifier: `SEQUENCE { OID 1.2.840.113549.1.1.1,
 * NULL }`.
 */
const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];

/**
 * Encode a DER length.
 * @param {number} length Length.
 * @returns {number[]} Encoded length.
 */
const encodeLength = (length) => {
  if (length < 0x80) {
    return [length];
  }

  /** @type {number[]} */
  const bytes = [];

  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) {
    bytes.unshift(rest % 256);
  }

  return [0x80 + bytes.length, ...bytes];
};

/**
 * Wrap DER content in a tag and length.
 * @param {number} tag Tag.
 * @param {number[] | Uint8Array} content Content.
 * @returns {number[]} Encoded value.
 */
const encode = (tag, content) => [tag, ...encodeLength(content.length), ...content];

/**
 * Convert a PKCS#1 RSA private key, the format GitHub issues, to PKCS#8, which Web Crypto needs.
 * @param {Uint8Array} pkcs1 DER-encoded PKCS#1 key.
 * @returns {Uint8Array} DER-encoded PKCS#8 key.
 */
export const pkcs1ToPkcs8 = (pkcs1) =>
  new Uint8Array(
    encode(0x30, [
      // Version 0
      0x02,
      0x01,
      0x00,
      ...RSA_ALGORITHM_IDENTIFIER,
      ...encode(0x04, pkcs1),
    ]),
  );

/**
 * Read a PEM-encoded RSA private key, in either PKCS#1 or PKCS#8 format, as PKCS#8.
 * @param {string} pem PEM.
 * @returns {Uint8Array} DER-encoded PKCS#8 key.
 * @throws {Error} If it isn’t an RSA private key.
 */
export const readPrivateKey = (pem) => {
  const match = pem.match(
    /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----/,
  );

  if (!match) {
    throw new Error('Not a PEM-encoded RSA private key.');
  }

  const der = Uint8Array.fromBase64(match[2].replace(/\s/g, ''));

  return match[1] ? pkcs1ToPkcs8(der) : der;
};

/**
 * Encode a PKCS#8 key as PEM.
 * @param {Uint8Array} der DER-encoded PKCS#8 key.
 * @returns {string} PEM.
 */
export const toPkcs8Pem = (der) =>
  [
    '-----BEGIN PRIVATE KEY-----',
    ...(der.toBase64().match(/.{1,64}/g) ?? []),
    '-----END PRIVATE KEY-----',
  ].join('\n');
