import { afterEach, describe, expect, test, vi } from 'vitest';

import { installFakeGitHub } from '../../test/fake-github.js';

import { exchangeCode, revokeUserGrant } from './oauth.js';

/** @type {(() => void) | undefined} */
let restore;

afterEach(() => {
  restore?.();
  restore = undefined;
  vi.unstubAllGlobals();
});

describe('exchangeCode()', () => {
  test('records a token that doesn’t expire as lasting a year, so it can still be revoked', async () => {
    const github = await installFakeGitHub();

    ({ restore } = github);
    github.state.oauthCodes.set('code', 'octocat');
    github.state.tokensExpire = false;

    const tokens = await exchangeCode({
      clientId: 'Iv1.client',
      clientSecret: 'client-secret',
      code: 'code',
      redirectUri: 'https://additions.example/v1/auth/callback/github',
    });
    const year = 365 * 24 * 60 * 60 * 1000;

    expect(Date.parse(tokens.expiresAt) - Date.now()).toBeGreaterThan(year - 60 * 1000);
    expect(tokens.refreshToken).toBe('');
  });
});

describe('revokeUserGrant()', () => {
  test('counts a grant as revoked only once GitHub says it’s gone', async () => {
    /**
     * Revoke a grant with GitHub answering the given status.
     * @param {number} status Status.
     * @returns {Promise<boolean>} Result.
     */
    const revokeWith = async (status) => {
      vi.stubGlobal('fetch', async () => new Response(null, { status }));

      return revokeUserGrant({ clientId: 'Iv1.client', clientSecret: 's', accessToken: 't' });
    };

    expect(await revokeWith(204)).toBe(true);
    expect(await revokeWith(404)).toBe(true);
    // GitHub limiting the requests
    expect(await revokeWith(422)).toBe(false);
    expect(await revokeWith(502)).toBe(false);
  });
});
