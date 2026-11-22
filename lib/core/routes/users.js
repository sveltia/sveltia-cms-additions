import { logAudit } from '../audit.js';
import { getAuth, requireDataKeys } from '../auth/index.js';
import { endUserAccess, requireSession } from '../auth/session.js';
import {
  assertNotLastAdmin,
  changeUserAccess,
  createUser,
  deleteUser,
  requireUser,
  resolveEmailChange,
  setPassword,
  toPublicUser,
  validateEmail,
  validateName,
  validatePrehash,
  validateRole,
  validateUsername,
} from '../auth/users.js';
import { revokeGitTokensForRequest } from '../git-tokens.js';
import { readJson } from '../http/body.js';
import { HttpError } from '../http/errors.js';
import { claimProviderAccount } from '../provider-accounts.js';
import { deleteProviderAccount, findProviderAccountRow } from '../store/provider-accounts.js';
import { countPendingRevocationsByUser } from '../store/tokens.js';
import { deleteRuleMember, listUserRows } from '../store/users.js';

/**
 * @import { Context, Hono } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * A username on a provider: GitHub’s rules, which GitLab’s and Gitea’s are close to.
 */
const LOGIN_REGEX = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

/**
 * Look up the user on the provider an admin names, to bind the account to their immutable ID there.
 * The error codes predate other providers, and the CMS knows them.
 * @param {Context<AppEnv>} c Hono context.
 * @param {unknown} login Username on the provider.
 * @returns {Promise<{ externalId: string, login: string }>} User on the provider.
 * @throws {HttpError} If there is no such user, or the provider isn’t set up.
 */
const resolveProviderLogin = async (c, login) => {
  if (typeof login !== 'string' || !LOGIN_REGEX.test(login)) {
    throw new HttpError(400, 'invalid_github_login', 'This is not a valid username.');
  }

  const connection = await c.get('gitProvider').connect(c.get('db'), await requireDataKeys(c));

  if (!connection) {
    throw new HttpError(409, 'github_app_not_set_up', 'The Git provider isn’t set up yet.');
  }

  const providerUser = await connection.findUser(login);

  if (!providerUser) {
    throw new HttpError(400, 'github_user_not_found', 'There is no user with this name.');
  }

  return { externalId: providerUser.id, login: providerUser.login };
};

/**
 * Register the user management endpoints, which only admins can use.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerUserRoutes = (app, platform) => {
  app.use('/v1/users', requireSession(platform, { role: 'admin' }));
  app.use('/v1/users/*', requireSession(platform, { role: 'admin' }));

  app.get('/v1/users', async (c) => {
    const rows = await listUserRows(c.get('db'), c.get('gitProvider').id);

    const pending = await countPendingRevocationsByUser(c.get('db'));

    return c.json({
      users: rows.map((row) => ({
        ...toPublicUser(/** @type {any} */ (row)),
        last_sign_in_at: row.lastSignInAt ? new Date(row.lastSignInAt).toISOString() : null,
        pending_token_revocations: pending.get(row.id) ?? 0,
        sign_in_methods: [
          ...(row.hasPassword ? ['password'] : []),
          ...(row.githubLogin ? ['github'] : []),
        ],
        // A GitHub account an admin named, which the person hasn’t signed in with yet
        github: row.githubLogin
          ? { login: row.githubLogin, waiting_for_sign_in: !row.githubSignedInAt }
          : null,
        sign_up_rule: row.ruleId ?? null,
      })),
    });
  });

  // Create a user with a temporary password, a GitHub account they sign in with, or both. The
  // admin’s browser generates the password, shows it once, and sends only its prehash
  app.post('/v1/users', async (c) => {
    const body = await readJson(c);

    if (body.prehash === undefined && body.github === undefined) {
      throw new HttpError(400, 'invalid_body', 'A password or a GitHub account is required.');
    }

    const username = validateUsername(body.username);
    const name = validateName(body.name);
    const email = validateEmail(body.email ?? null);
    const role = validateRole(body.role);
    const prehash = body.prehash === undefined ? undefined : validatePrehash(body.prehash);
    const github =
      body.github === undefined ? undefined : await resolveProviderLogin(c, body.github);

    const user = await createUser(await getAuth(c, platform), {
      username,
      name,
      email,
      role,
      prehash,
      mustChangePassword: !!prehash,
    });

    if (github) {
      try {
        await claimProviderAccount(c.get('db'), c.get('gitProvider').id, {
          userId: user.id,
          ...github,
        });
      } catch (error) {
        // Don’t leave a user nobody can sign in as
        await (await (await getAuth(c, platform)).$context).internalAdapter.deleteUser(user.id);

        throw error;
      }
    }

    await logAudit(c.get('db'), {
      action: 'user.create',
      actorId: c.get('user').id,
      target: user.id,
      meta: { role: user.role },
    });

    return c.json({ user: toPublicUser(user) }, 201);
  });

  app.patch('/v1/users/:id', async (c) => {
    const db = c.get('db');
    const target = await requireUser(db, c.req.param('id'));
    const body = await readJson(c);
    const { internalAdapter } = await (await getAuth(c, platform)).$context;
    /** @type {Record<string, any>} */
    const changes = {};

    if ('name' in body) {
      changes.name = validateName(body.name);
    }

    if ('email' in body) {
      changes.email = await resolveEmailChange(internalAdapter, target, body.email);
    }

    if ('role' in body) {
      changes.role = validateRole(body.role);
    }

    if ('disabled' in body) {
      if (typeof body.disabled !== 'boolean') {
        throw new HttpError(400, 'invalid_body', '`disabled` must be a boolean.');
      }

      if (body.disabled && target.id === c.get('user').id) {
        throw new HttpError(409, 'cannot_disable_self', 'You can’t disable your own account.');
      }

      changes.banned = body.disabled;
    }

    const githubChanged = 'github' in body;
    // A rule never makes anyone an admin, and an admin isn’t checked against one: promoting someone
    // a rule let in adopts them
    const adopted = body.adopted === true || changes.role === 'admin';

    if (!Object.keys(changes).length && !githubChanged && !adopted) {
      throw new HttpError(400, 'invalid_body', 'Nothing to change.');
    }

    // Everything that waits on something else, e.g. GitHub, is done before checking and changing
    // anything, so no other request can slip in between, e.g. another admin demoting this one
    // Only needed to revoke tokens, so a name change still works while the data key is locked
    const keys =
      changes.banned || changes.role || githubChanged ? await requireDataKeys(c) : undefined;
    const previousGitHub = githubChanged
      ? await findProviderAccountRow(db, c.get('gitProvider').id, { userId: target.id })
      : null;
    const github =
      githubChanged && body.github !== null ? await resolveProviderLogin(c, body.github) : null;

    if (github) {
      const owner = await findProviderAccountRow(db, c.get('gitProvider').id, {
        externalId: github.externalId,
      });

      if (owner && owner.user_id !== target.id) {
        throw new HttpError(
          409,
          'github_account_taken',
          'Another user signs in with this GitHub account.',
        );
      }
    }

    if ((changes.role && changes.role !== 'admin') || changes.banned) {
      await assertNotLastAdmin(db, target);
    }

    const { role, banned, ...otherChanges } = changes;

    // The name and the email, checked already, go first, so a refused role change leaves nothing
    // half done but them
    if (Object.keys(otherChanges).length) {
      await internalAdapter.updateUser(target.id, otherChanges);
    }

    // Checked again in the same statement as the change
    if (role !== undefined || banned !== undefined) {
      await changeUserAccess(db, target.id, { role, banned });
    }

    // Name, or forget, the GitHub account the user signs in with
    if (github) {
      await claimProviderAccount(db, c.get('gitProvider').id, { userId: target.id, ...github });
    } else if (githubChanged) {
      await deleteProviderAccount(db, c.get('gitProvider').id, target.id);
    }

    // Someone a sign-up rule let in becomes an ordinary account, no longer checked against the rule
    if (adopted) {
      await deleteRuleMember(db, target.id);
    }

    // Whoever signed in with the GitHub account the user had, e.g. someone named by mistake, is
    // signed out, and their own GitHub token revoked
    const githubReplaced = !!previousGitHub && previousGitHub.external_id !== github?.externalId;
    const roleChanged = !!changes.role && changes.role !== target.role;

    // A token keeps the permissions it was minted with, so revoke the user’s tokens rather than
    // wait up to an hour. The CMS then gets a new one for the new role. A role change only
    // concerns the installation tokens, as it doesn’t change what someone’s own GitHub token can do
    if (changes.banned || githubReplaced) {
      await revokeGitTokensForRequest(c, platform, keys, { userId: target.id });
      await endUserAccess(c, platform, target.id);
    } else if (roleChanged) {
      await revokeGitTokensForRequest(c, platform, keys, {
        userId: target.id,
        kind: 'installation',
      });
      // Their tabs connect again with the new role
      await endUserAccess(c, platform, target.id, { sessions: false });
    }

    await logAudit(db, {
      action: 'user.update',
      actorId: c.get('user').id,
      target: target.id,
      meta: {
        fields: [
          ...Object.keys(changes),
          ...(githubChanged ? ['github'] : []),
          ...(adopted ? ['adopted'] : []),
        ],
        role: changes.role,
        disabled: changes.banned,
      },
    });

    return c.json({ user: toPublicUser(await requireUser(db, target.id)) });
  });

  app.delete('/v1/users/:id', async (c) => {
    const db = c.get('db');
    const target = await requireUser(db, c.req.param('id'));

    if (target.id === c.get('user').id) {
      throw new HttpError(409, 'cannot_delete_self', 'You can’t delete your own account.');
    }

    await assertNotLastAdmin(db, target);

    await revokeGitTokensForRequest(c, platform, await requireDataKeys(c), { userId: target.id });
    // Checked again in the same statement as the deletion, so two admins deleting each other at
    // once can’t leave none
    await deleteUser(db, target.id);
    await endUserAccess(c, platform, target.id, { sessions: false });
    await logAudit(db, { action: 'user.delete', actorId: c.get('user').id, target: target.id });

    return c.json({ deleted: true });
  });

  // Reset a user’s password to a temporary one, which they must change at the next sign-in
  app.post('/v1/users/:id/password', async (c) => {
    const db = c.get('db');
    const target = await requireUser(db, c.req.param('id'));
    const { prehash } = await readJson(c);

    await setPassword(await getAuth(c, platform), target.id, validatePrehash(prehash), {
      mustChangePassword: true,
    });
    // Whatever the old password let someone start, e.g. linking their GitHub account, ends too;
    // the sessions are gone already
    await endUserAccess(c, platform, target.id, { sessions: false });
    await revokeGitTokensForRequest(c, platform, await requireDataKeys(c), { userId: target.id });

    await logAudit(db, {
      action: 'user.password_reset',
      actorId: c.get('user').id,
      target: target.id,
    });

    return c.json({ user: toPublicUser(await requireUser(db, target.id)) });
  });

  app.delete('/v1/users/:id/sessions', async (c) => {
    const db = c.get('db');
    const target = await requireUser(db, c.req.param('id'));

    await endUserAccess(c, platform, target.id);
    await revokeGitTokensForRequest(c, platform, await requireDataKeys(c), { userId: target.id });
    await logAudit(db, { action: 'user.sign_out', actorId: c.get('user').id, target: target.id });

    return c.json({ signed_out: true });
  });
};
