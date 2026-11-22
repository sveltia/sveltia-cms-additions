import { verifyAdminSecret } from '../admin-secret.js';
import { addAllowedOrigin, getAllowedDomains } from '../allowed-domains.js';
import { logAudit } from '../audit.js';
import { getAuth, requireDataKeys } from '../auth/index.js';
import { endUserAccess } from '../auth/session.js';
import {
  countActiveAdmins,
  createUser,
  findUserByUsername,
  setPassword,
  toPublicUser,
  validateName,
  validatePrehash,
  validateUsername,
} from '../auth/users.js';
import { getDataKeys, rekeyDataKey, rewrapDataKey } from '../crypto/data-key.js';
import { revokeGitTokensForRequest } from '../git-tokens.js';
import { readJson } from '../http/body.js';
import { HttpError } from '../http/errors.js';
import { getOrCreateSetting } from '../settings.js';
import { deleteSecretSettingRows } from '../store/settings.js';
import { deleteAllTokens } from '../store/tokens.js';
import { deleteAllSessions } from '../store/users.js';

/**
 * @import { Hono } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * Register the endpoints authenticated with `ADMIN_SECRET`. They work from any origin, so the first
 * admin and the allowed domains can be set up before anything else exists.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerSetupRoutes = (app, platform) => {
  // What has been set up, for the setup wizard in the CMS. The site ID salts the password
  // derivation the wizard needs to create an admin
  app.get('/v1/setup/status', async (c) => {
    await verifyAdminSecret(c, platform);

    const db = c.get('db');
    const [dataKey, admins, allowedDomains, providerStatus, siteId] = await Promise.all([
      getDataKeys(db, /** @type {string} */ (c.env.ADMIN_SECRET)),
      countActiveAdmins(db),
      getAllowedDomains(db),
      c.get('gitProvider').getSetupStatus(db),
      getOrCreateSetting(db, 'site_id', () => crypto.randomUUID()),
    ]);

    return c.json({
      site_id: siteId,
      data_key: dataKey.status,
      admins,
      allowed_domains: allowedDomains,
      git_provider: c.get('gitProvider').id,
      ...providerStatus,
    });
  });

  // Create an admin, or reset an existing admin’s password. Used on the first run and to get back
  // in after a lockout
  app.post('/v1/setup/admin', async (c) => {
    await verifyAdminSecret(c, platform);

    const db = c.get('db');
    const body = await readJson(c);
    const username = validateUsername(body.username);
    const prehash = validatePrehash(body.prehash);
    const auth = await getAuth(c, platform);
    const existing = await findUserByUsername(db, username);
    let user;

    if (existing) {
      if (existing.role !== 'admin') {
        throw new HttpError(
          409,
          'not_an_admin',
          'This user isn’t an admin. Choose another username, or promote them as an admin.',
        );
      }

      // The person holding the secret chose this password, so it doesn’t need changing
      await setPassword(auth, existing.id, prehash, { mustChangePassword: false });
      // Whatever the old password let someone start ends too; the sessions are gone already
      await endUserAccess(c, platform, existing.id, { sessions: false });
      await revokeGitTokensForRequest(c, platform, await requireDataKeys(c), {
        userId: existing.id,
      });
      await (await auth.$context).internalAdapter.updateUser(existing.id, { banned: false });
      await logAudit(db, { action: 'setup.admin_reset', target: existing.id });
      user = await findUserByUsername(db, username);
    } else {
      user = await createUser(auth, {
        username,
        name: validateName(body.name ?? username),
        role: 'admin',
        prehash,
        mustChangePassword: false,
      });
      await logAudit(db, { action: 'setup.admin_create', target: user.id });
    }

    const origin = c.req.header('origin');
    const allowedDomains =
      body.allow_origin === true && origin ? await addAllowedOrigin(db, origin) : undefined;

    return c.json({
      user: toPublicUser(/** @type {any} */ (user)),
      ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
    });
  });

  // Re-wrap the data key after `ADMIN_SECRET` was changed, using the previous secret, or replace it
  // when the previous secret was lost
  app.post('/v1/setup/secret', async (c) => {
    await verifyAdminSecret(c, platform);

    const db = c.get('db');
    const secret = /** @type {string} */ (c.env.ADMIN_SECRET);
    const { previous, rekey } = await readJson(c);

    if (typeof previous === 'string' && previous) {
      await rewrapDataKey(db, { previousSecret: previous, secret });
      await logAudit(db, { action: 'data_key.rewrap' });

      return c.json({ data_key: 'ok' });
    }

    if (rekey === true) {
      // Refuse to destroy data that can still be read
      if ((await getDataKeys(db, secret)).status === 'ok') {
        throw new HttpError(
          409,
          'data_key_unlocked',
          'The data key can be unlocked with the current admin secret, so it doesn’t need a re-key.',
        );
      }

      const version = await rekeyDataKey(db, secret);
      const deleted = await deleteSecretSettingRows(db);

      // The GitHub App can’t be used without its private key, so it has to be set up again
      await c.get('gitProvider').forgetConnection(db);

      // Sessions were signed with a key derived from the old data key, so they’re invalid now, and
      // GitHub tokens can no longer be decrypted to revoke them; they expire within an hour
      await deleteAllSessions(db);
      await deleteAllTokens(db);
      await logAudit(db, { action: 'data_key.rekey', meta: { version, deleted } });

      return c.json({ data_key: 'ok', deleted });
    }

    throw new HttpError(400, 'invalid_body', 'Send either `previous` or `rekey: true`.');
  });
};
