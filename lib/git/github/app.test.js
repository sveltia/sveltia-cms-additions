import { afterEach, describe, expect, test } from 'vitest';

import { fromBase64Url } from '../../core/crypto/encoding.js';
import { generateAppKey, installFakeGitHub } from '../../test/fake-github.js';

import {
  createAppJwt,
  mintInstallationToken,
  revokeInstallationToken,
  withInstallationToken,
} from './app.js';
import { readPrivateKey } from './pem.js';

/** @type {(() => void) | undefined} */
let restore;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('readPrivateKey()', () => {
  test('converts a PKCS#1 key to the same PKCS#8 key Web Crypto exports', async () => {
    const { pkcs1Pem, pkcs8Pem } = await generateAppKey();

    expect(readPrivateKey(pkcs1Pem)).toEqual(readPrivateKey(pkcs8Pem));
  });

  test('refuses something that isn’t a private key', () => {
    expect(() =>
      readPrivateKey('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----'),
    ).toThrow('Not a PEM-encoded RSA private key');
  });
});

describe('createAppJwt()', () => {
  test('signs a short-lived JWT issued by the app', async () => {
    const { publicKey, pkcs1Pem } = await generateAppKey();
    const jwt = await createAppJwt({ appId: 42, privateKey: pkcs1Pem });
    const [header, payload, signature] = jwt.split('.');
    const decode = (/** @type {string} */ part) =>
      JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
    const now = Date.now() / 1000;

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload).iss).toBe('42');
    expect(decode(payload).iat).toBeLessThan(now - 30);
    expect(decode(payload).exp - decode(payload).iat).toBeLessThanOrEqual(10 * 60);

    await expect(
      crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        publicKey,
        fromBase64Url(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).resolves.toBe(true);
  });
});

describe('installation tokens', () => {
  test('are minted for one repository and revoked', async () => {
    const github = await installFakeGitHub();

    ({ restore } = github);

    const credentials = { appId: github.state.appId, privateKey: github.pkcs8Pem };
    const minted = await mintInstallationToken(credentials, {
      installationId: github.state.installationId,
      repository: 'site',
      permissions: { contents: 'read' },
    });

    expect(minted.permissions).toEqual({ contents: 'read' });
    expect(minted.repositories).toEqual([{ id: 303, full_name: 'sveltia/site' }]);

    await expect(revokeInstallationToken(minted.token)).resolves.toBe(true);
    expect(github.state.revoked.has(minted.token)).toBe(true);

    // Revoking again is fine: the token is unusable either way
    await expect(revokeInstallationToken(minted.token)).resolves.toBe(true);
  });

  test('are refused for a repository outside the installation', async () => {
    const github = await installFakeGitHub();

    ({ restore } = github);

    await expect(
      mintInstallationToken(
        { appId: github.state.appId, privateKey: github.pkcs8Pem },
        { installationId: github.state.installationId, repository: 'other', permissions: {} },
      ),
    ).rejects.toThrow('GitHub responded with 422');
  });

  test('are revoked once a task is done with them, whether it worked or not', async () => {
    const github = await installFakeGitHub();

    ({ restore } = github);

    const credentials = { appId: github.state.appId, privateKey: github.pkcs8Pem };
    const args = {
      installationId: github.state.installationId,
      repository: 'site',
      permissions: { metadata: 'read' },
    };
    /** @type {string[]} */
    const tokens = [];

    await expect(
      withInstallationToken(credentials, args, async ({ token, repositories }) => {
        tokens.push(token);

        return repositories.length;
      }),
    ).resolves.toBe(1);

    await expect(
      withInstallationToken(credentials, args, async ({ token }) => {
        tokens.push(token);
        throw new Error('Task failed');
      }),
    ).rejects.toThrow('Task failed');

    expect(tokens.every((token) => github.state.revoked.has(token))).toBe(true);
  });

  test('report a failed revocation so it can be retried', async () => {
    const github = await installFakeGitHub();

    ({ restore } = github);
    github.state.revocationFails = true;

    await expect(revokeInstallationToken('ghs_anything')).resolves.toBe(false);
  });
});
