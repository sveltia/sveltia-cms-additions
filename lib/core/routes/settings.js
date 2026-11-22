import { getAllowedDomains, setAllowedDomains } from '../allowed-domains.js';
import { logAudit } from '../audit.js';
import { requireDataKeys } from '../auth/index.js';
import { requireSession } from '../auth/session.js';
import {
  getCommitAuthorMode,
  setCommitAuthorMode,
  validateCommitAuthorMode,
} from '../commit-author.js';
import { getCredentials, setCredentials, validateCredentials } from '../credentials.js';
import { readJson } from '../http/body.js';
import { HttpError } from '../http/errors.js';
import { setSetting } from '../settings.js';
import {
  getSignInMethods,
  getSignUpRules,
  SIGN_IN_METHODS_SETTING,
  SIGN_UP_RULES_SETTING,
  validateSignInMethods,
  validateSignUpRules,
} from '../sign-in.js';

/**
 * @import { Hono } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * Register the settings endpoints, which only admins can use: the allowed domains, the commit
 * author, sign-in methods and sign-up rules, and the shared credentials. The Git provider’s own
 * settings, e.g. the GitHub App’s, are its adapter’s.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerSettingsRoutes = (app, platform) => {
  app.use('/v1/settings', requireSession(platform, { role: 'admin' }));
  app.use('/v1/settings/*', requireSession(platform, { role: 'admin' }));

  /**
   * Get the plain settings.
   * @param {import('../../types.js').Database} db Database.
   * @returns {Promise<Record<string, any>>} Settings.
   */
  const getSettings = async (db) => ({
    allowed_domains: await getAllowedDomains(db),
    commit_author: await getCommitAuthorMode(db),
    sign_in_methods: await getSignInMethods(db),
    sign_up_rules: await getSignUpRules(db),
  });

  app.get('/v1/settings', async (c) => c.json(await getSettings(c.get('db'))));

  app.patch('/v1/settings', async (c) => {
    const db = c.get('db');
    const body = await readJson(c);
    const actorId = c.get('user').id;

    const keys = ['allowed_domains', 'commit_author', 'sign_in_methods', 'sign_up_rules'];

    if (!keys.some((key) => key in body)) {
      throw new HttpError(400, 'invalid_body', 'Nothing to change.');
    }

    // Check everything before saving anything: the allowed domains are checked as they’re saved
    const commitAuthor =
      'commit_author' in body ? validateCommitAuthorMode(body.commit_author) : undefined;

    const signInMethods =
      'sign_in_methods' in body ? validateSignInMethods(body.sign_in_methods) : undefined;

    const signUpRules =
      'sign_up_rules' in body
        ? validateSignUpRules(body.sign_up_rules, await c.get('gitProvider').getRepository(db))
        : undefined;

    /** @type {Record<string, any>} */
    const changes = {};

    if ('allowed_domains' in body) {
      // The site the admin is using must stay allowed, or they’d lock themselves out
      changes.allowed_domains = await setAllowedDomains(db, body.allowed_domains, {
        actorId,
        currentOrigin: c.req.header('origin'),
      });
    }

    if (commitAuthor) {
      await setCommitAuthorMode(db, commitAuthor, { actorId });
      changes.commit_author = commitAuthor;
    }

    if (signInMethods) {
      await setSetting(db, SIGN_IN_METHODS_SETTING, signInMethods, { actorId });
      changes.sign_in_methods = signInMethods;
    }

    if (signUpRules) {
      await setSetting(db, SIGN_UP_RULES_SETTING, signUpRules, { actorId });
      changes.sign_up_rules = signUpRules;
    }

    await logAudit(db, { action: 'settings.update', actorId, meta: changes });

    return c.json(await getSettings(db));
  });

  // The credentials every user gets, e.g. API keys and the deploy hook. Only the services are
  // logged, not the values
  app.put('/v1/settings/credentials', async (c) => {
    const db = c.get('db');
    const keys = await requireDataKeys(c);
    const credentials = validateCredentials(await readJson(c));
    const actorId = c.get('user').id;

    await setCredentials(db, keys, credentials, { actorId });
    await logAudit(db, {
      action: 'settings.credentials',
      actorId,
      meta: {
        api_keys: Object.keys(credentials.api_keys),
        deploy_hook: !!credentials.deploy_hook,
      },
    });
    // Open tabs load them again; the values aren’t sent over the socket
    await platform.realtime?.broadcast(c.env, { type: 'credentials' });

    return c.json(await getCredentials(db, keys));
  });
};
