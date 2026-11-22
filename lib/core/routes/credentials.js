import { requireDataKeys } from '../auth/index.js';
import { requireSession } from '../auth/session.js';
import { getCredentials } from '../credentials.js';

/**
 * @import { Hono } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * Register the endpoint handing the shared credentials to every signed-in user, viewers included:
 * the CMS calls these services from the browser, so whoever uses it gets the keys anyway. Admins
 * change them under `/v1/settings/credentials`.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerCredentialRoutes = (app, platform) => {
  app.use('/v1/credentials', requireSession(platform));

  app.get('/v1/credentials', async (c) =>
    c.json(await getCredentials(c.get('db'), await requireDataKeys(c))),
  );
};
