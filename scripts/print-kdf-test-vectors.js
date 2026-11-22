/**
 * Print test vectors for the browser’s password derivation, saved as `docs/kdf-test-vectors.json`.
 * Run with `node scripts/print-kdf-test-vectors.js > docs/kdf-test-vectors.json`.
 */
import { derivePrehash, KDF_ITERATIONS } from '../lib/client/kdf.js';

const inputs = [
  {
    siteId: '3f1c2a9e-5b7d-4e2f-9a6c-0d8b7e1f2a3c',
    username: 'admin',
    password: 'correct horse battery staple',
  },
  {
    siteId: '3f1c2a9e-5b7d-4e2f-9a6c-0d8b7e1f2a3c',
    username: 'Admin',
    password: 'correct horse battery staple',
  },
  {
    siteId: '3f1c2a9e-5b7d-4e2f-9a6c-0d8b7e1f2a3c',
    username: 'editor',
    // cspell:disable-next-line
    password: 'pässwörd 日本語',
  },
  {
    siteId: '00000000-0000-0000-0000-000000000000',
    username: 'admin',
    password: 'correct horse battery staple',
  },
];

const vectors = await Promise.all(
  inputs.map(async (input) => ({ ...input, prehash: await derivePrehash(input) })),
);

// eslint-disable-next-line no-console
console.log(JSON.stringify({ version: 'v1', iterations: KDF_ITERATIONS, vectors }, null, 2));
