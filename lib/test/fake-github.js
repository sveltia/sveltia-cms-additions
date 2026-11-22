import { vi } from 'vitest';

import { fromBase64Url, toBase64Url, toUtf8 } from '../core/crypto/encoding.js';

/**
 * Read a DER length at an offset.
 * @param {Uint8Array} der DER bytes.
 * @param {number} offset Offset of the length.
 * @returns {{ length: number, size: number }} Length, and how many bytes encode it.
 */
const readLength = (der, offset) => {
  if (der[offset] < 0x80) {
    return { length: der[offset], size: 1 };
  }

  const count = der[offset] - 0x80;
  let length = 0;

  for (let index = 1; index <= count; index += 1) {
    length = length * 256 + der[offset + index];
  }

  return { length, size: count + 1 };
};

/**
 * Extract the PKCS#1 key from a PKCS#8 key, the reverse of what the app does, to produce keys in the
 * format GitHub issues.
 * @param {Uint8Array} pkcs8 DER-encoded PKCS#8 key.
 * @returns {Uint8Array} DER-encoded PKCS#1 key.
 */
export const pkcs8ToPkcs1 = (pkcs8) => {
  // Skip the outer sequence header, the version (3 bytes) and the algorithm identifier (15 bytes)
  const outer = readLength(pkcs8, 1);
  const octetOffset = 1 + outer.size + 3 + 15;
  const inner = readLength(pkcs8, octetOffset + 1);
  const start = octetOffset + 1 + inner.size;

  return pkcs8.slice(start, start + inner.length);
};

/**
 * Encode DER as PEM.
 * @param {Uint8Array} der DER bytes.
 * @param {string} label PEM label, e.g. `RSA PRIVATE KEY`.
 * @returns {string} PEM.
 */
export const toPem = (der, label) =>
  [
    `-----BEGIN ${label}-----`,
    ...(der.toBase64().match(/.{1,64}/g) ?? []),
    `-----END ${label}-----`,
  ].join('\n');

/**
 * Generate an RSA key pair like a GitHub App’s.
 * @returns {Promise<{ publicKey: CryptoKey, pkcs1Pem: string, pkcs8Pem: string }>} Keys.
 */
export const generateAppKey = async () => {
  const { publicKey, privateKey } = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )
  );

  const pkcs8 = new Uint8Array(
    /** @type {ArrayBuffer} */ (await crypto.subtle.exportKey('pkcs8', privateKey)),
  );

  return {
    publicKey,
    pkcs1Pem: toPem(pkcs8ToPkcs1(pkcs8), 'RSA PRIVATE KEY'),
    pkcs8Pem: toPem(pkcs8, 'PRIVATE KEY'),
  };
};

/**
 * Verify a JWT signed by the app, and return its payload.
 * @param {string} jwt JWT.
 * @param {CryptoKey} publicKey App’s public key.
 * @returns {Promise<any>} Payload, or `null` if the signature is wrong.
 */
const verifyJwt = async (jwt, publicKey) => {
  const [header, payload, signature] = jwt.split('.');

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    fromBase64Url(signature),
    toUtf8(`${header}.${payload}`),
  );

  return valid ? JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) : null;
};

/**
 * ID of the first repository of the installation, as `configureGitHubApp()` records it.
 */
export const FIRST_REPOSITORY_ID = 303;

/**
 * Install a fake GitHub API in place of `fetch`. It knows one app, installed on the given
 * repositories of one account.
 * @param {object} args Arguments.
 * @param {number} [args.appId] App ID.
 * @param {string} [args.account] Account the app is installed on.
 * @param {'User' | 'Organization'} [args.accountType] Account type.
 * @param {string[]} [args.repositories] Repository names the installation includes. Each has
 * the ID {@link FIRST_REPOSITORY_ID} plus its position, which stays the same when a test renames
 * it by changing the name in `state.repositories`.
 * @returns {Promise<{ state: any, publicKey: CryptoKey, pkcs1Pem: string, pkcs8Pem: string,
 * restore: () => void }>} Fake GitHub’s state and keys.
 */
export const installFakeGitHub = async ({
  appId = 101,
  account = 'sveltia',
  accountType = 'User',
  repositories = ['site'],
} = {}) => {
  const key = await generateAppKey();

  const state = {
    appId,
    installationId: 202,
    account,
    repositories,
    /** @type {Map<string, { permissions: any, repository: string }>} */
    tokens: new Map(),
    /** @type {Set<string>} */
    revoked: new Set(),
    /** Whether revocation requests fail, to simulate an outage. */
    revocationFails: false,
    /** Whether the installation is suspended. */
    suspended: false,
    defaultBranch: 'main',
    /**
     * Rulesets that apply to the default branch.
     * @type {{ id: number, rules: string[], bypass?: string }[]}
     */
    rulesets: [],
    /**
     * GitHub users who can sign in, by username.
     * @type {Map<string, { id: number, login: string, name: string | null }>}
     */
    users: new Map([
      ['octocat', { id: 501, login: 'octocat', name: 'Mona Octocat' }],
      ['hubot', { id: 502, login: 'hubot', name: null }],
    ]),
    /**
     * OAuth codes GitHub would send to the callback, with the user who authorized the app.
     * @type {Map<string, string>}
     */
    oauthCodes: new Map(),
    /**
     * User-to-server tokens, with the user they belong to.
     * @type {Map<string, string>}
     */
    userTokens: new Map(),
    /**
     * Refresh tokens that haven’t been used yet, with the user they belong to.
     * @type {Map<string, string>}
     */
    refreshTokens: new Map(),
    /** Users whose authorization of the app has been revoked. */
    revokedGrants: /** @type {string[]} */ ([]),
    /** Members of the organization the app is installed on. */
    orgMembers: new Set(['octocat']),
    /** Whether refresh requests fail. */
    refreshFails: false,
    /** Whether the token endpoint is down, keeping the refresh token. */
    tokenEndpointDown: false,
    /** Whether membership checks fail, to simulate an outage. */
    membershipFails: false,
    /** Whether the organization can’t be found, as after it was renamed. */
    organizationMissing: false,
    /** Whether revoking a user’s authorization of the app fails, to simulate an outage. */
    grantRevocationFails: false,
    /**
     * Function run while an installation token is being minted, before GitHub answers, e.g. to
     * change something meanwhile.
     * @type {(() => Promise<void>) | undefined}
     */
    whileMinting: undefined,
    /** Whether user-to-server tokens expire, as the app’s setting has them by default. */
    tokensExpire: true,
    /**
     * Whether GitHub refuses requests without credentials, as when other users of the same IP
     * address have used up the hourly limit.
     */
    anonymousRateLimited: false,
    /** Whether GitHub refuses to mint installation tokens because the app sent too many requests. */
    mintingRateLimited: false,
    /** @type {string[]} */
    requests: [],
  };

  /**
   * Respond with JSON.
   * @param {number} status Status.
   * @param {any} [body] Body.
   * @returns {Response} Response.
   */
  const json = (status, body) =>
    body === undefined ? new Response(null, { status }) : Response.json(body, { status });

  /**
   * Check that a request is authenticated as the app.
   * @param {Request} request Request.
   * @returns {Promise<boolean>} Result.
   */
  const isApp = async (request) => {
    const jwt = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const payload = await verifyJwt(jwt, key.publicKey).catch(() => null);

    return payload?.iss === String(appId) && payload.exp > Date.now() / 1000;
  };

  const realFetch = globalThis.fetch;

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;

    state.requests.push(route);

    /**
     * Issue a user-to-server token and its refresh token.
     * @param {string} login User.
     * @returns {Response} Token response.
     */
    const issueUserTokens = (login) => {
      const token = `ghu_${toBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
      const refreshToken = `ghr_${toBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`;

      state.userTokens.set(token, login);
      state.refreshTokens.set(refreshToken, login);

      // With expiry turned off for the app, the token never expires and has no refresh token
      return json(
        200,
        state.tokensExpire
          ? {
              access_token: token,
              expires_in: 28800,
              refresh_token: refreshToken,
              refresh_token_expires_in: 15724800,
              token_type: 'bearer',
            }
          : { access_token: token, token_type: 'bearer' },
      );
    };

    if (route === 'POST /login/oauth/access_token') {
      const params = new URLSearchParams(await request.text());

      if (
        params.get('client_id') !== 'Iv1.client' ||
        params.get('client_secret') !== 'client-secret'
      ) {
        return json(200, { error: 'incorrect_client_credentials' });
      }

      if (params.get('grant_type') === 'refresh_token') {
        if (state.tokenEndpointDown) {
          return json(502, { message: 'Bad gateway' });
        }

        const login = state.refreshTokens.get(params.get('refresh_token') ?? '');

        state.refreshTokens.delete(params.get('refresh_token') ?? '');

        return login && !state.refreshFails
          ? issueUserTokens(login)
          : json(200, { error: 'bad_refresh_token' });
      }

      const login = state.oauthCodes.get(params.get('code') ?? '');

      state.oauthCodes.delete(params.get('code') ?? '');

      return login ? issueUserTokens(login) : json(200, { error: 'bad_verification_code' });
    }

    if (!request.url.startsWith('https://api.github.com/')) {
      return realFetch(input, init);
    }

    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';

    if (
      (state.anonymousRateLimited && !request.headers.has('authorization')) ||
      (state.mintingRateLimited && route.endsWith('/access_tokens'))
    ) {
      return Response.json(
        { message: 'API rate limit exceeded for 172.70.206.75.' },
        {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 25 * 60),
          },
        },
      );
    }

    if (route === 'GET /user') {
      const login = state.userTokens.get(bearer);

      return login && !state.revokedGrants.includes(login)
        ? json(200, state.users.get(login))
        : json(401, { message: 'Bad credentials' });
    }

    let match = route.match(/^GET \/users\/([^/]+)$/);

    if (match) {
      const user = state.users.get(match[1].toLowerCase());

      if (user) {
        return json(200, { ...user, type: 'User' });
      }

      // Any other name exists, except those made up to not exist
      return match[1].startsWith('nobody')
        ? json(404, { message: 'Not Found' })
        : json(200, {
            id: 900,
            login: match[1],
            type: match[1] === account ? accountType : 'User',
          });
    }

    match = route.match(/^GET \/orgs\/([^/]+)$/);

    if (match) {
      return match[1] === account && !state.organizationMissing
        ? json(200, { login: account })
        : json(404, { message: 'Not Found' });
    }

    match = route.match(/^GET \/orgs\/([^/]+)\/members\/([^/]+)$/);

    if (match) {
      const grant = state.tokens.get(bearer);

      if (!grant || state.revoked.has(bearer) || grant.permissions?.members !== 'read') {
        return json(403, { message: 'Resource not accessible by integration' });
      }

      if (state.membershipFails) {
        return json(502, { message: 'Bad gateway' });
      }

      return match[1] === account && state.orgMembers.has(match[2]) ? json(204) : json(404);
    }

    match = route.match(/^DELETE \/applications\/([^/]+)\/grant$/);

    if (match) {
      if (state.grantRevocationFails) {
        return json(502, { message: 'Bad gateway' });
      }

      const { access_token: token } = await request.json();
      const login = state.userTokens.get(token);

      if (!login) {
        return json(404, { message: 'Not Found' });
      }

      // Like GitHub, the grant takes every token it issued with it, newer ones included
      state.revokedGrants.push(login);
      [state.refreshTokens, state.userTokens].forEach((tokens) => {
        tokens.forEach((owner, value) => {
          if (owner === login) {
            tokens.delete(value);
          }
        });
      });

      return json(204);
    }

    match = route.match(/^POST \/app-manifests\/([^/]+)\/conversions$/);

    if (match) {
      return match[1] === 'good-code'
        ? json(201, {
            id: appId,
            slug: 'sveltia-cms-site',
            client_id: 'Iv1.client',
            client_secret: 'client-secret',
            webhook_secret: 'webhook-secret',
            pem: key.pkcs1Pem,
            owner: { login: account, type: accountType },
            html_url: 'https://github.com/apps/sveltia-cms-site',
          })
        : json(404, { message: 'Not Found' });
    }

    if (route === 'GET /app') {
      return (await isApp(request))
        ? json(200, {
            id: appId,
            slug: 'sveltia-cms-site',
            owner: { login: account, type: accountType },
          })
        : json(401, { message: 'Bad credentials' });
    }

    match = route.match(/^GET \/app\/installations\/(\d+)$/);

    if (match) {
      if (!(await isApp(request))) {
        return json(401, { message: 'Bad credentials' });
      }

      return Number(match[1]) === state.installationId
        ? json(200, {
            id: state.installationId,
            account: { login: account, type: accountType },
            suspended_at: state.suspended ? '2026-10-01T00:00:00Z' : null,
          })
        : json(404, { message: 'Not Found' });
    }

    match = route.match(/^POST \/app\/installations\/(\d+)\/access_tokens$/);

    if (match) {
      if (!(await isApp(request))) {
        return json(401, { message: 'Bad credentials' });
      }

      const body = await request.json();

      // Like GitHub, by ID or by name
      const [repository] = body.repository_ids
        ? body.repository_ids.map(
            (/** @type {number} */ id) => state.repositories[id - FIRST_REPOSITORY_ID],
          )
        : (body.repositories ?? []);

      if (!state.repositories.includes(repository)) {
        return json(422, { message: 'There is at least one repository that does not exist' });
      }

      const token = `ghs_${toBase64Url(crypto.getRandomValues(new Uint8Array(18)))}`;

      state.tokens.set(token, { permissions: body.permissions, repository });

      const { whileMinting } = state;

      state.whileMinting = undefined;
      await whileMinting?.();

      return json(201, {
        token,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(/\.\d+/, ''),
        permissions: body.permissions,
        repositories: [
          {
            id: FIRST_REPOSITORY_ID + state.repositories.indexOf(repository),
            full_name: `${account}/${repository}`,
          },
        ],
      });
    }

    match = route.match(/^GET \/repos\/([^/]+)\/([^/]+)(\/.*)?$/);

    if (match) {
      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const grant = state.tokens.get(token);

      if (!grant || state.revoked.has(token) || grant.repository !== match[2]) {
        return json(404, { message: 'Not Found' });
      }

      const rest = match[3] ?? '';

      if (!rest) {
        return json(200, { name: match[2], default_branch: state.defaultBranch });
      }

      if (rest === `/rules/branches/${state.defaultBranch}`) {
        return json(
          200,
          state.rulesets.flatMap(({ id, rules }) =>
            rules.map((type) => ({ type, ruleset_source_type: 'Repository', ruleset_id: id })),
          ),
        );
      }

      const ruleset = state.rulesets.find(({ id }) => rest === `/rulesets/${id}`);

      if (ruleset) {
        return json(200, { id: ruleset.id, current_user_can_bypass: ruleset.bypass ?? 'never' });
      }
    }

    if (route === 'DELETE /installation/token') {
      if (state.revocationFails) {
        return json(503, { message: 'Unavailable' });
      }

      const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';

      if (!state.tokens.has(token) || state.revoked.has(token)) {
        return json(401, { message: 'Bad credentials' });
      }

      state.revoked.add(token);

      return json(204);
    }

    return json(404, { message: 'Not Found' });
  });

  /**
   * Put the real `fetch` back.
   */
  const restore = () => {
    spy.mockRestore();
  };

  return { state, ...key, restore };
};
