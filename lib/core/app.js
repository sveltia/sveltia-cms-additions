import { Hono } from 'hono';

import { getAdminSecretStatus } from './admin-secret.js';
import { countActiveAdmins } from './auth/users.js';
import {
  API_VERSION,
  KDF_VERSION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PRODUCT_NAME,
} from './constants.js';
import { getDataKeys } from './crypto/data-key.js';
import { getGitProvider } from './git-provider.js';
import { cors } from './http/cors.js';
import { useJsonErrors } from './http/errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerCredentialRoutes } from './routes/credentials.js';
import { registerLockRoutes } from './routes/locks.js';
import { registerProviderAuthRoutes } from './routes/provider-auth.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerUserRoutes } from './routes/users.js';
import { getSiteId } from './settings.js';
import { getSignInMethods } from './sign-in.js';

/**
 * @import { AppEnv, Platform } from '../types.js';
 * @import { GitProvider } from './git-provider.js';
 */

/**
 * Escape a string for HTML text.
 * @param {string} str String.
 * @returns {string} Escaped string.
 */
const escapeHtml = (str) =>
  str.replace(/[&<>"']/g, (char) => `&#${/** @type {number} */ (char.codePointAt(0))};`);

/**
 * Create the platform-agnostic app.
 * @param {Platform} platform Platform services.
 * @param {object} options Options.
 * @param {GitProvider[]} options.gitProviders Git providers the deployment supports, the default
 * first. The site uses one of them.
 * @returns {Hono<AppEnv>} App.
 */
export const createApp = (platform, { gitProviders }) => {
  /** @type {Hono<AppEnv>} */
  const app = new Hono();

  // Errors become JSON responses. They still pass back through the CORS middleware, so the CMS can
  // read them
  useJsonErrors(app);

  // Make the database available and up to date before anything else
  app.use(async (c, next) => {
    const { db, authDatabase } = await platform.resolveTenant(c.env);

    c.set('db', db);
    c.set('authDatabase', authDatabase);
    c.set('gitProvider', await getGitProvider(db, gitProviders));
    await next();
  });

  app.use(cors());

  app.get('/', (c) =>
    c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<title>${PRODUCT_NAME}</title></head><body>` +
        `<h1>${PRODUCT_NAME}</h1><p>Version ${escapeHtml(PACKAGE_VERSION)}</p>` +
        '<p>This service works together with Sveltia CMS. ' +
        'To set it up, sign in to your CMS and choose <em>Use admin secret</em>.</p>' +
        '</body></html>',
    ),
  );

  app.get('/version', async (c) => {
    const db = c.get('db');
    const provider = c.get('gitProvider');
    const repository = await provider.getRepository(db);
    const adminSecretStatus = getAdminSecretStatus(c.env.ADMIN_SECRET);

    const dataKeyStatus =
      adminSecretStatus === 'ok'
        ? (await getDataKeys(db, /** @type {string} */ (c.env.ADMIN_SECRET))).status
        : 'unavailable';

    return c.json({
      name: PRODUCT_NAME,
      package: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      api: API_VERSION,
      platform: platform.name,
      git_host: provider.id,
      site_id: await getSiteId(db),
      kdf: KDF_VERSION,
      // The provider needs to be set up as well as turned on
      sign_in_methods: [
        'password',
        .../** @type {Record<string, boolean>} */ (
          (await getSignInMethods(db))[provider.id] && repository ? [provider.id] : []
        ),
      ],
      features: ['users', 'locks', 'comments', 'credentials'],
      // How the CMS learns about changes: over a connection, or by polling
      realtime: platform.realtime?.kind ?? 'none',
      setup: {
        admin_secret: adminSecretStatus,
        data_key: dataKeyStatus,
        admin: (await countActiveAdmins(db)) > 0,
        // Named after GitHub, which the CMS knows, but true once any provider is set up
        github_app: !!repository,
      },
    });
  });

  // Before the core’s own, so their middleware, e.g. on `/v1/settings/*`, doesn’t apply to the
  // providers’ routes, which bring their own
  gitProviders.forEach((provider) => provider.registerRoutes(app, platform));
  registerSetupRoutes(app, platform);
  registerAuthRoutes(app, platform);
  registerUserRoutes(app, platform);
  registerLockRoutes(app, platform);
  registerProviderAuthRoutes(app, platform);
  registerCommentRoutes(app, platform);
  registerCredentialRoutes(app, platform);
  registerSettingsRoutes(app, platform);

  return app;
};
