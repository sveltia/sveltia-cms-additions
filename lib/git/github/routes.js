import { verifyAdminSecret } from '../../core/admin-secret.js';
import { logAudit } from '../../core/audit.js';
import { requireDataKeys } from '../../core/auth/index.js';
import { requireSession } from '../../core/auth/session.js';
import { getRandomBytes, toBase64Url } from '../../core/crypto/encoding.js';
import { revokeGitTokensForRequest } from '../../core/git-tokens.js';
import { readJson } from '../../core/http/body.js';
import { HttpError } from '../../core/http/errors.js';
import { getSecretSetting, getSiteId, setSecretSetting } from '../../core/settings.js';
import { deleteSettings } from '../../core/store/settings.js';
import {
  advanceSetupState,
  deleteSetupState,
  findSetupState,
  insertSetupState,
} from '../../core/store/setup-states.js';

import { GitHubError } from './api.js';
import {
  convertManifestCode,
  createAppJwt,
  getAccountType,
  getApp,
  getInstallation,
  withInstallationToken,
} from './app.js';
import { readPrivateKey, toPkcs8Pem } from './pem.js';
import {
  getGitHubAppInfo,
  GITHUB_SETTINGS,
  saveGitHubApp,
  saveGitHubInstallation,
} from './settings.js';
import { getGitHubStatus } from './status.js';

/**
 * @import { Context, Hono } from 'hono';
 * @import { AppEnv, Database, Platform } from '../../types.js';
 */

/**
 * How long a setup run may take, matching the validity of GitHub’s manifest code.
 */
const SETUP_STATE_TTL = 60 * 60 * 1000;

/**
 * A repository, as `owner/name`.
 */
const REPOSITORY_REGEX = /^([\w.-]+)\/([\w.-]+)$/;

/**
 * GitHub’s maximum length of an app name.
 */
const MAX_APP_NAME_LENGTH = 34;

/**
 * Get a setup run by its state, if it exists, is at the given stage and hasn’t expired.
 * @param {Database} db Database.
 * @param {string | undefined} state State.
 * @param {string} stage Expected stage.
 * @returns {Promise<{ state: string, repo: string, return_url: string } | null>} Setup run.
 */
const getSetupState = async (db, state, stage) =>
  state ? ((await findSetupState(db, state, stage)) ?? null) : null;

/**
 * Redirect back to the CMS with the outcome of the setup in the query, keeping its hash route.
 * @param {Context<AppEnv>} c Hono context.
 * @param {string} returnUrl CMS URL the setup started from.
 * @param {string} result `ok` or an error code.
 * @returns {Response} Redirect.
 */
const redirectBack = (c, returnUrl, result) => {
  const url = new URL(returnUrl);

  url.searchParams.set('additions_setup', result);

  return c.redirect(url.toString(), 303);
};

/**
 * Get the name of a new GitHub App for the site. App names are unique across GitHub, and an agency
 * may set up the same repository name for several clients, so it names the owner as well, and ends
 * with a few characters of the site’s random ID, e.g. `Sveltia CMS acme website 7f3a`.
 * @param {string} repo Repository, as `owner/name`.
 * @param {string} siteId Site ID.
 * @returns {string} Name, as long as GitHub allows at most.
 */
export const getAppName = (repo, siteId) => {
  const suffix = siteId.replaceAll('-', '').slice(0, 4);
  const label = `Sveltia CMS ${repo.replace('/', ' ')}`;

  return `${label.slice(0, MAX_APP_NAME_LENGTH - suffix.length - 1).trimEnd()} ${suffix}`;
};

/**
 * Build the manifest of a new GitHub App for the site.
 * @param {object} args Arguments.
 * @param {string} args.origin URL of this service, including the tenant’s path, if any.
 * @param {string} args.repo Repository, as `owner/name`.
 * @param {string} args.siteId Site ID, which makes the app’s name unique.
 * @returns {Record<string, any>} Manifest.
 */
export const buildManifest = ({ origin, repo, siteId }) => ({
  name: getAppName(repo, siteId),
  url: origin,
  description: `Sveltia CMS Additions for ${repo}`,
  public: false,
  redirect_url: `${origin}/v1/setup/github/callback`,
  setup_url: `${origin}/v1/setup/github/installed`,
  setup_on_update: true,
  callback_urls: [`${origin}/v1/auth/callback/github`],
  request_oauth_on_install: false,
  // Webhooks aren’t used yet
  hook_attributes: { url: `${origin}/v1/webhooks/github`, active: false },
  default_permissions: {
    contents: 'write',
    metadata: 'read',
    pull_requests: 'write',
    statuses: 'read',
    // Organization permission, to check who belongs to the organization of a sign-up rule
    members: 'read',
  },
  default_events: [],
});

/**
 * Register the GitHub App setup: creating the app from a manifest, then installing it on the site’s
 * repository. The CMS starts it with the admin secret and submits the manifest to GitHub; GitHub
 * then sends the browser back here twice, and finally we redirect to the CMS.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
const registerSetupRoutes = (app, platform) => {
  app.post('/v1/setup/github', async (c) => {
    await verifyAdminSecret(c, platform);

    const db = c.get('db');
    const { repo, return_url: returnUrl, replace } = await readJson(c);
    const origin = c.req.header('origin');

    if (typeof repo !== 'string' || !REPOSITORY_REGEX.test(repo)) {
      throw new HttpError(400, 'invalid_repository', 'The repository must be `owner/name`.');
    }

    if (
      typeof returnUrl !== 'string' ||
      !URL.canParse(returnUrl) ||
      !['https:', 'http:'].includes(new URL(returnUrl).protocol) ||
      // Only the CMS starts the setup, from its page, which a browser sends the origin of
      new URL(returnUrl).origin !== origin
    ) {
      throw new HttpError(400, 'invalid_return_url', 'The return URL must be on the CMS’s origin.');
    }

    if ((await getGitHubAppInfo(db)) && replace !== true) {
      throw new HttpError(
        409,
        'github_app_exists',
        'A GitHub App is already set up. Send `replace: true` to register another one.',
      );
    }

    const owner = repo.split('/')[0];
    const ownerType = await getAccountType(owner);
    const state = toBase64Url(getRandomBytes(24));
    const now = Date.now();

    await insertSetupState(db, {
      state,
      stage: 'manifest',
      repo,
      return_url: returnUrl,
      created_at: now,
      expires_at: now + SETUP_STATE_TTL,
    });

    const actionUrl = new URL(
      ownerType === 'Organization'
        ? `https://github.com/organizations/${owner}/settings/apps/new`
        : 'https://github.com/settings/apps/new',
    );

    actionUrl.searchParams.set('state', state);

    return c.json({
      action_url: actionUrl.toString(),
      manifest: buildManifest({
        origin: platform.getBaseURL(c.req.raw),
        repo,
        siteId: await getSiteId(db),
      }),
    });
  });

  // GitHub created the app: store its credentials, then go on to install it
  app.get('/v1/setup/github/callback', async (c) => {
    const db = c.get('db');
    const setup = await getSetupState(db, c.req.query('state'), 'manifest');

    if (!setup) {
      throw new HttpError(400, 'invalid_state', 'This setup link has expired. Start again.');
    }

    const code = c.req.query('code');

    if (!code) {
      return redirectBack(c, setup.return_url, 'github_app_not_created');
    }

    const keys = await requireDataKeys(c);

    // Only one request goes on with a run, should the callback be loaded twice at once
    if (!(await advanceSetupState(db, setup.state, 'manifest', 'creating'))) {
      throw new HttpError(400, 'invalid_state', 'This setup link has expired. Start again.');
    }

    /** @type {Awaited<ReturnType<typeof convertManifestCode>>} */
    let created;

    try {
      created = await convertManifestCode(code);
    } catch (error) {
      // GitHub hasn’t created the app, and the code is still good: the run can be tried again, e.g.
      // once GitHub is back, still reporting what went wrong
      await advanceSetupState(db, setup.state, 'creating', 'manifest').catch(() => undefined);

      throw error;
    }

    // From here on, the app exists on GitHub, and its credentials can’t be fetched again: they’re
    // saved whatever else fails. The previous app’s tokens are revoked first, while its credentials
    // are still there, which revoking a user’s own token takes; any GitHub couldn’t revoke expire
    // on their own, unused, as the cached ones are no longer handed out
    try {
      await revokeGitTokensForRequest(c, platform, keys, { everyone: true });
    } catch {
      // Left to expire
    }

    await saveGitHubApp(db, keys, {
      info: {
        id: created.id,
        slug: created.slug,
        clientId: created.client_id,
        owner: created.owner?.login ?? setup.repo.split('/')[0],
        ownerType: created.owner?.type === 'Organization' ? 'Organization' : 'User',
        htmlUrl: created.html_url,
      },
      privateKey: toPkcs8Pem(readPrivateKey(created.pem)),
      clientSecret: created.client_secret,
      webhookSecret: created.webhook_secret ?? '',
    });

    // A new app needs a new installation
    await deleteSettings(db, [GITHUB_SETTINGS.installation]);

    await advanceSetupState(db, setup.state, 'creating', 'install');
    await logAudit(db, {
      action: 'github.app_create',
      meta: { id: created.id, slug: created.slug },
    });

    const installUrl = new URL(`https://github.com/apps/${created.slug}/installations/new`);

    installUrl.searchParams.set('state', setup.state);

    return c.redirect(installUrl.toString(), 303);
  });

  // GitHub installed the app: check that the installation covers the repository, then return to
  // the CMS
  app.get('/v1/setup/github/installed', async (c) => {
    const db = c.get('db');
    const setup = await getSetupState(db, c.req.query('state'), 'install');

    if (!setup) {
      throw new HttpError(400, 'invalid_state', 'This setup link has expired. Start again.');
    }

    const installationId = Number(c.req.query('installation_id'));
    const keys = await requireDataKeys(c);
    const info = await getGitHubAppInfo(db);
    const privateKey = await getSecretSetting(db, keys, GITHUB_SETTINGS.privateKey);

    if (!installationId || !info || !privateKey) {
      return redirectBack(c, setup.return_url, 'github_app_not_installed');
    }

    const credentials = { appId: info.id, privateKey };
    const [owner, name] = setup.repo.split('/');
    /** @type {Awaited<ReturnType<typeof getInstallation>>} */
    let installation;

    try {
      installation = await getInstallation(credentials, installationId);
    } catch (error) {
      return redirectBack(
        c,
        setup.return_url,
        error instanceof GitHubError ? 'github_app_not_installed' : 'unexpected',
      );
    }

    // An installation may have no account, e.g. one on an enterprise
    if (installation.account?.login?.toLowerCase() !== owner.toLowerCase()) {
      return redirectBack(c, setup.return_url, 'github_wrong_account');
    }

    /** @type {import('../../git/github/app.js').InstallationToken['repositories']} */
    let repositories;

    try {
      // Mint a minimal token to make sure the installation includes the repository
      repositories = await withInstallationToken(
        credentials,
        { installationId, repository: name, permissions: { metadata: 'read' } },
        async (probe) => probe.repositories,
      );
    } catch (error) {
      // GitHub refuses a token for a repository the installation doesn’t include; anything else,
      // e.g. a network error, says nothing about that
      return redirectBack(
        c,
        setup.return_url,
        error instanceof GitHubError && error.githubStatus < 500
          ? 'github_repository_not_included'
          : 'unexpected',
      );
    }

    const repository = repositories.find(
      ({ full_name: fullName }) => fullName.toLowerCase() === setup.repo.toLowerCase(),
    );

    await saveGitHubInstallation(db, {
      id: installationId,
      owner: installation.account.login,
      name: repository?.full_name.split('/')[1] ?? name,
      repositoryId: repository?.id ?? 0,
    });

    await deleteSetupState(db, setup.state);
    await logAudit(db, {
      action: 'github.app_install',
      meta: { installation_id: installationId, repo: setup.repo },
    });

    return redirectBack(c, setup.return_url, 'ok');
  });
};

/**
 * Register the GitHub App’s settings, which only admins can see and change: its status, checked
 * with GitHub, and its private key.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
const registerSettingsRoutes = (app, platform) => {
  const requireAdmin = requireSession(platform, { role: 'admin' });

  // The GitHub App, checked with GitHub
  app.get('/v1/settings/github', requireAdmin, async (c) =>
    c.json(await getGitHubStatus(c.get('db'), await requireDataKeys(c))),
  );

  // Replace the app’s private key, e.g. after it leaked or was lost with the data key. The key is
  // tried with GitHub first, so a key of another app can’t lock the service out
  app.put('/v1/settings/github/private-key', requireAdmin, async (c) => {
    const db = c.get('db');
    const keys = await requireDataKeys(c);
    const { private_key: pem } = await readJson(c);
    const info = await getGitHubAppInfo(db);

    if (!info) {
      throw new HttpError(409, 'github_app_missing', 'No GitHub App has been registered yet.');
    }

    /** @type {string} */
    let privateKey;

    try {
      privateKey = toPkcs8Pem(readPrivateKey(String(pem)));
      // Make sure Web Crypto can use it
      await createAppJwt({ appId: info.id, privateKey });
    } catch {
      throw new HttpError(400, 'invalid_private_key', 'This is not a valid private key.');
    }

    try {
      await getApp({ appId: info.id, privateKey });
    } catch (error) {
      if (error instanceof GitHubError && error.githubStatus === 401) {
        throw new HttpError(
          400,
          'private_key_mismatch',
          'GitHub doesn’t accept this private key for the app.',
        );
      }

      throw error;
    }

    const actorId = c.get('user').id;

    await setSecretSetting(db, keys, GITHUB_SETTINGS.privateKey, privateKey, { actorId });
    await logAudit(db, { action: 'github.private_key_replace', actorId, meta: { app: info.id } });

    return c.json(await getGitHubStatus(db, keys));
  });
};

/**
 * Register the GitHub routes: setting up the app from a manifest and installing it, and its
 * settings. They’re registered before the core’s, so the core’s `/v1/settings/*` middleware doesn’t
 * run on top of their own.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerGitHubRoutes = (app, platform) => {
  registerSetupRoutes(app, platform);
  registerSettingsRoutes(app, platform);
};
