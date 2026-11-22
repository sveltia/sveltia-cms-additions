import { getClientKey } from '../admin-secret.js';
import { logAudit } from '../audit.js';
import { issueCode, startFlow, takeFlow, validateFlowParams } from '../auth/flows.js';
import { getAuth, requireDataKeys } from '../auth/index.js';
import { endUserAccess, requireSession } from '../auth/session.js';
import { createUser, findUserById, findUserByUsername } from '../auth/users.js';
import { revokeGitTokensForRequest } from '../git-tokens.js';
import { HttpError } from '../http/errors.js';
import { claimProviderAccount, storeUserTokens } from '../provider-accounts.js';
import { consumeRateLimits } from '../rate-limit.js';
import { getSignInMethods, getSignUpRules } from '../sign-in.js';
import { insertFlow } from '../store/flows.js';
import { findProviderAccountRow, updateProviderLogin } from '../store/provider-accounts.js';
import {
  deletePasswordAccount,
  findRuleMember,
  findUserRuleId,
  insertRuleMember,
  touchRuleMember,
  updateUserAccessUnlessLastAdmin,
} from '../store/users.js';

/**
 * @import { Context, Hono } from 'hono';
 * @import { AppEnv, Database, Platform } from '../../types.js';
 * @import { SignUpRule } from '../sign-in.js';
 * @import { ProviderConnection, UserTokens } from '../git-provider.js';
 * @import { PendingLink } from '../auth/flows.js';
 * @import { DataKeys } from '../crypto/data-key.js';
 */

/**
 * Rate limit on starting a sign-in through a provider, per client.
 */
const START_LIMIT = { limit: 30, windowSeconds: 600 };

/**
 * How long a request to link an account on the provider may wait for the popup to open.
 */
const LINK_TTL = 5 * 60 * 1000;

/**
 * Get the connection to the site’s provider, if signing in with it is turned on and it’s set up.
 * @param {Context<AppEnv>} c Hono context.
 * @returns {Promise<ProviderConnection>} Connection.
 * @throws {HttpError} If signing in with the provider isn’t available.
 */
const requireProviderSignIn = async (c) => {
  const db = c.get('db');
  const provider = c.get('gitProvider');
  const [methods, connection] = await Promise.all([
    getSignInMethods(db),
    provider.connect(db, await requireDataKeys(c)),
  ]);

  if (!(/** @type {Record<string, boolean>} */ (methods)[provider.id]) || !connection) {
    throw new HttpError(403, 'method_disabled', 'Signing in with this provider is turned off.');
  }

  return connection;
};

/**
 * Make sure a request is for the site’s provider, as the routes name it.
 * @param {Context<AppEnv>} c Hono context.
 * @throws {HttpError} If it’s for another provider.
 */
const assertSiteProvider = (c) => {
  if (c.req.param('provider') !== c.get('gitProvider').id) {
    throw new HttpError(404, 'not_found', 'The site doesn’t use this provider.');
  }
};

/**
 * Make a username from a username on the provider, unique among the users.
 * @param {Database} db Database.
 * @param {string} login Username on the provider.
 * @returns {Promise<string>} Username.
 */
const createUsername = async (db, login) => {
  const base = login
    .toLowerCase()
    .replace(/[^a-z\d._-]/g, '-')
    .padEnd(3, '-')
    .slice(0, 26);

  for (let index = 1; ; index += 1) {
    const username = index === 1 ? base : `${base}-${index}`;

    // eslint-disable-next-line no-await-in-loop
    if (!(await findUserByUsername(db, username))) {
      return username;
    }
  }
};

/**
 * How often the membership of someone a sign-up rule let in is checked again while they keep using
 * a session, besides every sign-in with the provider.
 */
const RULE_RECHECK_INTERVAL = 60 * 60 * 1000;

/**
 * Disable someone a sign-up rule let in who no longer belongs to the organization, ending their
 * access, unless they are the last admin who can sign in: then their account stays as it is.
 * @param {Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
const disableLapsedMember = async (c, platform, keys, userId) => {
  const db = c.get('db');

  if (!(await updateUserAccessUnlessLastAdmin(db, userId, { banned: true }))) {
    return;
  }

  await endUserAccess(c, platform, userId);
  await revokeGitTokensForRequest(c, platform, keys, { userId });
  await logAudit(db, { action: 'user.rule_disable', target: userId });
};

/**
 * Check again, at most every hour, that someone a sign-up rule let in still belongs to the
 * organization, when they keep using a session without signing in with the provider again.
 * @param {Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 * @throws {HttpError} If they no longer belong to it, and have been disabled.
 */
export const recheckRuleMember = async (c, platform, userId) => {
  const db = c.get('db');
  const member = await findRuleMember(db, userId);

  if (!member || (member.checked_at ?? 0) > Date.now() - RULE_RECHECK_INTERVAL) {
    return;
  }

  const provider = c.get('gitProvider');
  const keys = await requireDataKeys(c);
  const [account, connection, rules] = await Promise.all([
    findProviderAccountRow(db, provider.id, { userId }),
    provider.connect(db, keys),
    getSignUpRules(db),
  ]);

  if (!account || !connection) {
    return;
  }

  const rule = rules.find(({ id }) => id === member.rule_id);
  const stillMember = rule ? await connection.isGroupMember(rule.org, account.login) : false;

  // The provider couldn’t tell: checked again next time
  if (stillMember === null) {
    return;
  }

  if (stillMember) {
    await touchRuleMember(db, userId);

    return;
  }

  await disableLapsedMember(c, platform, keys, userId);

  if ((await findUserById(db, userId))?.banned) {
    throw new HttpError(403, 'user_disabled', 'This account is disabled.');
  }

  // Kept as the last admin: checked again in an hour, not at every request
  await touchRuleMember(db, userId);
};

/**
 * Let a user sign in with their account on the provider from now on: an admin’s temporary password
 * stops working, the username there is kept current and their own tokens are stored.
 * @param {Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {{ id: string, mustChangePassword?: boolean }} user User.
 * @param {{ login: string, tokens: UserTokens }} identity Username on the provider and tokens.
 * @returns {Promise<void>}
 */
const adoptProviderIdentity = async (c, platform, keys, user, { login, tokens }) => {
  const db = c.get('db');
  const { id: provider } = c.get('gitProvider');

  // A temporary password an admin made up was only a way in: someone who has signed in with the
  // provider doesn’t need it, and it shouldn’t keep working as the admin knows it
  if (user.mustChangePassword) {
    const { internalAdapter } = await (await getAuth(c, platform)).$context;

    await deletePasswordAccount(db, user.id);
    await internalAdapter.updateUser(user.id, { mustChangePassword: false });
  }

  // Keep the username current, as it can change on the provider
  await updateProviderLogin(db, provider, user.id, login);
  await storeUserTokens(db, keys, provider, user.id, tokens);
};

/**
 * Link an account on the provider to a user, once the CMS that asked for the link has exchanged
 * its code.
 * @param {Context<AppEnv>} c Hono context.
 * @param {Platform} platform Platform.
 * @param {DataKeys} keys Keys derived from the data key.
 * @param {string} userId User ID.
 * @param {PendingLink} link Account on the provider and tokens.
 * @returns {Promise<void>}
 * @throws {HttpError} When the user can no longer sign in, or someone else has the account now.
 */
export const completeProviderLink = async (c, platform, keys, userId, link) => {
  const db = c.get('db');
  const { id: provider } = c.get('gitProvider');
  // A link made before the providers were generalized names the account by its GitHub ID
  const externalId = link.externalId ?? /** @type {any} */ (link).githubId;
  const user = await findUserById(db, userId);

  if (!user || user.banned) {
    throw new HttpError(403, 'user_disabled', 'This user can’t sign in.');
  }

  const previous = await findProviderAccountRow(db, provider, { userId });

  await claimProviderAccount(db, provider, { userId, externalId, login: link.login });

  // The account the user had until now, whose own token mustn’t be handed out any more
  if (previous && previous.external_id !== externalId) {
    await revokeGitTokensForRequest(c, platform, keys, { userId, kind: 'user' });
  }

  await adoptProviderIdentity(c, platform, keys, user, link);
  await logAudit(db, { action: 'auth.link', actorId: userId, meta: { [provider]: link.login } });
};

/**
 * Register signing in with the site’s Git provider: the start of the flow, linking an existing
 * account, and the provider’s callback, which sends the user back to the CMS with a one-time code.
 * The paths name the provider, e.g. `/v1/auth/start/github`.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerProviderAuthRoutes = (app, platform) => {
  // The CMS’s auth popup comes here with its PKCE parameters, and goes on to the provider
  app.get('/v1/auth/start/:provider', async (c) => {
    assertSiteProvider(c);

    const db = c.get('db');
    const provider = c.get('gitProvider');

    // Anyone can start a sign-in, which stores a record until it expires
    await consumeRateLimits(platform, c.env, [
      {
        key: `auth_start:client:${getClientKey(c.req.header('cf-connecting-ip'))}`,
        ...START_LIMIT,
      },
    ]);

    const connection = await requireProviderSignIn(c);
    const params = await validateFlowParams(db, c.req.query());
    const link = c.req.query('link');
    /** @type {string | null} */
    let linkUserId = null;

    if (link) {
      linkUserId = (await takeFlow(db, link, `${provider.id}-link`))?.link_user_id ?? null;

      if (!linkUserId) {
        throw new HttpError(400, 'invalid_state', 'This link has expired. Try again.');
      }
    }

    const state = await startFlow(db, { provider: provider.id, ...params, linkUserId });

    return c.redirect(
      connection.signIn.getAuthorizeUrl({
        redirectUri: `${platform.getBaseURL(c.req.raw)}/v1/auth/callback/${provider.id}`,
        state,
      }),
      302,
    );
  });

  // Prepare linking an account on the provider to the signed-in user. The popup can’t carry the
  // session, so it gets a short-lived reference to it instead
  app.post('/v1/auth/link/:provider', requireSession(platform), async (c) => {
    assertSiteProvider(c);
    await requireProviderSignIn(c);

    const link = crypto.randomUUID();

    await insertFlow(c.get('db'), {
      state: link,
      provider: `${c.get('gitProvider').id}-link`,
      redirect_uri: '',
      client_state: '',
      code_challenge: '',
      link_user_id: c.get('user').id,
      expires_at: Date.now() + LINK_TTL,
    });

    return c.json({ link });
  });

  app.get('/v1/auth/callback/:provider', async (c) => {
    assertSiteProvider(c);

    const db = c.get('db');
    const provider = c.get('gitProvider');
    const flow = await takeFlow(db, c.req.query('state'), provider.id);

    if (!flow) {
      throw new HttpError(400, 'invalid_state', 'This sign-in has expired. Start again.');
    }

    /**
     * Send the user back to the CMS.
     * @param {Record<string, string>} params Query parameters.
     * @returns {Response} Redirect.
     */
    const back = (params) => {
      const url = new URL(flow.redirect_uri);

      Object.entries({ ...params, state: flow.client_state }).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });

      return c.redirect(url.toString(), 302);
    };

    const code = c.req.query('code');

    if (!code) {
      return back({ error: 'access_denied' });
    }

    // An admin may have turned signing in with the provider off since the sign-in started
    if (!(/** @type {Record<string, boolean>} */ (await getSignInMethods(db))[provider.id])) {
      return back({ error: 'method_disabled' });
    }

    const keys = await requireDataKeys(c);
    const connection = await provider.connect(db, keys);

    if (!connection) {
      return back({ error: 'not_set_up' });
    }

    /** @type {UserTokens} */
    let tokens;
    /** @type {import('../git-provider.js').ProviderUser} */
    let providerUser;

    try {
      tokens = await connection.signIn.exchangeCode({
        code,
        redirectUri: `${platform.getBaseURL(c.req.raw)}/v1/auth/callback/${provider.id}`,
      });
      providerUser = await connection.signIn.getUser(tokens.accessToken);
    } catch {
      // The error code predates other providers, and the CMS knows it
      return back({ error: 'github_error' });
    }

    const { id: externalId, login } = providerUser;
    /** @type {any} */
    let user;

    if (flow.link_user_id) {
      user = await findUserById(db, flow.link_user_id);

      if (!user || user.banned) {
        return back({ error: 'user_disabled' });
      }

      const owner = await findProviderAccountRow(db, provider.id, { externalId });

      if (owner && owner.user_id !== user.id) {
        return back({ error: 'github_account_taken' });
      }

      // Nothing is linked yet: whoever authorized on the provider may not be the user who asked for
      // the link, e.g. someone sent a link URL by them. The link is made when the code is exchanged,
      // which only the CMS that started it can do, as it holds the PKCE verifier
      return back({
        code: await issueCode(db, {
          userId: user.id,
          codeChallenge: flow.code_challenge,
          redirectUri: flow.redirect_uri,
          pending: { keys, link: { externalId, login, tokens } },
        }),
      });
    }

    const account = await findProviderAccountRow(db, provider.id, { externalId });
    const rules = await getSignUpRules(db);

    if (account) {
      user = await findUserById(db, account.user_id);

      const ruleId = await findUserRuleId(db, account.user_id);

      // Someone a rule let in is checked against it again, until an admin adopts them
      if (ruleId && !user.banned) {
        const rule = rules.find(({ id }) => id === ruleId);

        const stillMember = rule ? await connection.isGroupMember(rule.org, login) : false;

        // The provider couldn’t tell: this sign-in fails, but the account stays as it is
        if (stillMember === null) {
          return back({ error: 'github_error' });
        }

        if (!stillMember) {
          await disableLapsedMember(c, platform, keys, user.id);

          return back({ error: 'not_invited' });
        }

        await touchRuleMember(db, user.id);
      }
    } else {
      /** @type {SignUpRule | undefined} */
      let matched;
      let unknown = false;

      // eslint-disable-next-line no-restricted-syntax
      for (const rule of rules) {
        // eslint-disable-next-line no-await-in-loop
        const isMember = await connection.isGroupMember(rule.org, login);

        if (isMember) {
          matched = rule;
          break;
        }

        unknown ||= isMember === null;
      }

      // Someone the provider couldn’t check is told so, rather than that they aren’t invited
      if (!matched) {
        return back({ error: unknown ? 'github_error' : 'not_invited' });
      }

      user = await createUser(await getAuth(c, platform), {
        username: await createUsername(db, login),
        // The user API allows 100 characters; a provider may allow more
        name: (providerUser.name || login).slice(0, 100),
        role: matched.role,
        mustChangePassword: false,
      });
      try {
        await claimProviderAccount(db, provider.id, { userId: user.id, externalId, login });
      } catch (error) {
        // Another sign-in of the same person got there first: the account just made goes
        await (await (await getAuth(c, platform)).$context).internalAdapter.deleteUser(user.id);

        if (error instanceof HttpError) {
          return back({ error: error.code });
        }

        throw error;
      }

      await insertRuleMember(db, user.id, matched.id);
      await logAudit(db, {
        action: 'user.rule_create',
        target: user.id,
        meta: { rule: matched.id, provider: provider.id, [provider.id]: login },
      });
    }

    if (!user || user.banned) {
      return back({ error: 'user_disabled' });
    }

    await adoptProviderIdentity(c, platform, keys, user, { login, tokens });
    await logAudit(db, { action: 'auth.sign_in', actorId: user.id, meta: { method: provider.id } });

    return back({
      code: await issueCode(db, {
        userId: user.id,
        codeChallenge: flow.code_challenge,
        redirectUri: flow.redirect_uri,
      }),
    });
  });
};
