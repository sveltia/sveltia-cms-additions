import { describe, expect, test } from 'vitest';

import vectors from '../../docs/kdf-test-vectors.json' with { type: 'json' };

import { derivePrehash } from './kdf.js';

describe('derivePrehash()', () => {
  test.each(vectors.vectors)('matches the test vector for $username on $siteId', async (vector) => {
    await expect(derivePrehash(vector)).resolves.toBe(vector.prehash);
  });

  test('treats composed and decomposed characters alike', async () => {
    const args = { siteId: 'site', username: 'user', iterations: 1000 };

    await expect(derivePrehash({ ...args, password: 'e\u0301' })).resolves.toBe(
      await derivePrehash({ ...args, password: '\u00e9' }),
    );
  });
});
