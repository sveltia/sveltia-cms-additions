import { getAllowedDomains, isOriginAllowed } from '../allowed-domains.js';
import { decryptValue, encryptValue } from '../crypto/data-key.js';
import { toBase64Url, toUtf8 } from '../crypto/encoding.js';
import { HttpError } from '../http/errors.js';
import {
  deleteUserFlows,
  insertCode,
  insertFlow,
  takeCodeRow,
  takeFlowRow,
} from '../store/flows.js';

/**
 * Sign-in through a provider, with this service acting as an OAuth authorization server for the
 * CMS: the CMS sends the user here with a PKCE challenge, the provider sends them back here, and
 * this service sends them on to the CMS with a one-time code that only the holder of the PKCE
 * verifier can exchange for a session.
 */

/**
 * @import { Database } from '../../types.js';
 * @import { DataKeys } from '../crypto/data-key.js';
 * @import { UserTokens } from '../git-provider.js';
 * @import { Auth } from './index.js';
 */

/**
 * How long a sign-in through a provider may take.
 */
const FLOW_TTL = 10 * 60 * 1000;

/**
 * How long a one-time code can be exchanged.
 */
const CODE_TTL = 60 * 1000;

/**
 * A PKCE S256 challenge: a base64url-encoded SHA-256 hash.
 */
const CODE_CHALLENGE_REGEX = /^[\w-]{43}$/;

/**
 * A sign-in in progress.
 * @typedef {object} AuthFlow
 * @property {string} state State sent to the provider.
 * @property {string} provider Provider, e.g. `github`.
 * @property {string} redirect_uri CMS page to return to.
 * @property {string} client_state State the CMS sent, returned to it as is.
 * @property {string} code_challenge PKCE challenge.
 * @property {string | null} link_user_id User whose account the identity is linked to, for a link
 * rather than a sign-in.
 */

/**
 * A GitHub account to link to a user, with the user-to-server tokens of the authorization, held
 * with the one-time code until the CMS that started the link exchanges it.
 * @typedef {object} PendingLink
 * @property {string} externalId The provider’s ID of the user.
 * @property {string} login Username on the provider.
 * @property {UserTokens} tokens The user’s own tokens there.
 */

/**
 * Get the AAD of a pending link, which ties it to its code.
 * @param {string} codeHash Hash of the code.
 * @returns {string} AAD.
 */
const getPendingLinkAad = (codeHash) => `auth_code:link_ciphertext:${codeHash}`;

/**
 * Create a random token.
 * @returns {string} Token.
 */
const createRandomToken = () => toBase64Url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Hash a value with SHA-256, as base64url.
 * @param {string} value Value.
 * @returns {Promise<string>} Hash.
 */
const sha256 = async (value) => toBase64Url(await crypto.subtle.digest('SHA-256', toUtf8(value)));

/**
 * Check the parameters the CMS starts a sign-in with. The page to return to has to be on an allowed
 * domain, so a code is never sent anywhere else.
 * @param {Database} db Database.
 * @param {Record<string, string | undefined>} params Query parameters.
 * @returns {Promise<{ redirectUri: string, clientState: string, codeChallenge: string }>} Checked
 * parameters.
 * @throws {HttpError} If they’re invalid.
 */
export const validateFlowParams = async (db, params) => {
  const {
    redirect_uri: redirectUri = '',
    state: clientState = '',
    code_challenge: codeChallenge = '',
    code_challenge_method: method = 'S256',
  } = params;

  if (
    !URL.canParse(redirectUri) ||
    !isOriginAllowed(new URL(redirectUri).origin, await getAllowedDomains(db))
  ) {
    throw new HttpError(400, 'invalid_redirect_uri', 'The CMS page isn’t on an allowed domain.');
  }

  if (method !== 'S256' || !CODE_CHALLENGE_REGEX.test(codeChallenge)) {
    throw new HttpError(400, 'invalid_request', 'An S256 PKCE challenge is required.');
  }

  if (!clientState || clientState.length > 200) {
    throw new HttpError(400, 'invalid_request', 'A state is required.');
  }

  return { redirectUri, clientState, codeChallenge };
};

/**
 * Record a sign-in in progress.
 * @param {Database} db Database.
 * @param {object} args Arguments.
 * @param {string} args.provider Provider.
 * @param {string} args.redirectUri CMS page to return to.
 * @param {string} args.clientState State the CMS sent.
 * @param {string} args.codeChallenge PKCE challenge.
 * @param {string | null} [args.linkUserId] User to link the identity to, for a link.
 * @returns {Promise<string>} State to send to the provider.
 */
export const startFlow = async (
  db,
  { provider, redirectUri, clientState, codeChallenge, linkUserId = null },
) => {
  const state = createRandomToken();

  await insertFlow(db, {
    state,
    provider,
    redirect_uri: redirectUri,
    client_state: clientState,
    code_challenge: codeChallenge,
    link_user_id: linkUserId,
    expires_at: Date.now() + FLOW_TTL,
  });

  return state;
};

/**
 * Take a sign-in in progress, which can only be done once.
 * @param {Database} db Database.
 * @param {string | undefined} state State.
 * @param {string} provider Expected provider.
 * @returns {Promise<AuthFlow | null>} Flow, if it exists and hasn’t expired.
 */
export const takeFlow = async (db, state, provider) => {
  if (!state) {
    return null;
  }

  // Taken whatever it turns out to be, so a state can’t be tried again
  const flow = await takeFlowRow(db, state);

  return flow?.provider === provider && flow.expires_at > Date.now() ? flow : null;
};

/**
 * Issue a one-time code for a user who has signed in, bound to the PKCE challenge and the page to
 * return to.
 * @param {Database} db Database.
 * @param {object} args Arguments.
 * @param {string} args.userId User ID.
 * @param {string} args.codeChallenge PKCE challenge.
 * @param {string} args.redirectUri Page to return to.
 * @param {{ keys: DataKeys, link: PendingLink }} [args.pending] A GitHub account to link to the
 * user once the code is exchanged, with the keys to encrypt its tokens with.
 * @returns {Promise<string>} Code.
 */
export const issueCode = async (db, { userId, codeChallenge, redirectUri, pending }) => {
  const code = createRandomToken();
  const codeHash = await sha256(code);

  await insertCode(db, {
    code_hash: codeHash,
    user_id: userId,
    code_challenge: codeChallenge,
    redirect_uri: redirectUri,
    expires_at: Date.now() + CODE_TTL,
    link_ciphertext: pending
      ? await encryptValue(pending.keys, JSON.stringify(pending.link), getPendingLinkAad(codeHash))
      : null,
  });

  return code;
};

/**
 * Exchange a one-time code, which only works once, before it expires, with the PKCE verifier of
 * its challenge and from the page it was issued for.
 * @param {Database} db Database.
 * @param {Record<string, any>} params Token request parameters.
 * @param {() => Promise<DataKeys>} getKeys Function that gets the keys to decrypt a pending link
 * with, only called for a link.
 * @returns {Promise<{ userId: string, link: PendingLink | null }>} ID of the user who signed in,
 * and the GitHub account to link to them, for a link.
 * @throws {HttpError} If the code can’t be exchanged.
 */
export const redeemCode = async (
  db,
  { code, code_verifier: verifier, redirect_uri: redirectUri },
  getKeys,
) => {
  const invalid = new HttpError(400, 'invalid_grant', 'The code is invalid or has expired.');

  if (typeof code !== 'string' || typeof verifier !== 'string' || !code || !verifier) {
    throw invalid;
  }

  const codeHash = await sha256(code);
  // Taken whatever it turns out to be, so a code can’t be tried again
  const row = await takeCodeRow(db, codeHash);

  if (
    !row ||
    row.expires_at <= Date.now() ||
    row.redirect_uri !== redirectUri ||
    (await sha256(verifier)) !== row.code_challenge
  ) {
    throw invalid;
  }

  if (!row.link_ciphertext) {
    return { userId: row.user_id, link: null };
  }

  const link = await decryptValue(
    await getKeys(),
    row.link_ciphertext,
    getPendingLinkAad(codeHash),
  );

  // The data key has been replaced since, which only an admin does
  if (!link) {
    throw invalid;
  }

  return { userId: row.user_id, link: JSON.parse(link) };
};

/**
 * Create a session for a user, as a signed token the `bearer` plugin accepts, like the one a
 * password sign-in returns.
 * @param {Auth} auth Better Auth instance.
 * @param {string} userId User ID.
 * @returns {Promise<{ session: any, token: string }>} Session and signed token.
 */
export const createSessionToken = async (auth, userId) => {
  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(userId);

  const key = await crypto.subtle.importKey(
    'raw',
    toUtf8(ctx.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  // Standard base64 with padding, as `better-call` signs cookies
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, toUtf8(session.token)),
  ).toBase64();

  return { session, token: `${session.token}.${signature}` };
};

/**
 * Forget a user’s sign-ins in progress: the references to link a GitHub account to them, and the
 * one-time codes not exchanged yet. Once their sessions have been ended, e.g. after a password
 * change, none of these may start a new one.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const forgetPendingFlows = async (db, userId) => {
  await deleteUserFlows(db, userId);
};
