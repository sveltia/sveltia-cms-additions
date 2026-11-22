/**
 * Storage of the users, as Better Auth keeps them (`user`, `account`, `session`), for what the core
 * reads or changes itself, and of who a sign-up rule let in (`rule_member`).
 * @import { Database } from '../../types.js';
 * @import { UserRow } from '../auth/users.js';
 */

/**
 * Condition that a user is an admin who can sign in. It’s never NULL, e.g. for a user without a
 * role, so its negation is true for anyone else.
 * @param {import('kysely').ExpressionBuilder<any, any>} eb Expression builder.
 * @param {string} [table] Table name or alias.
 * @returns {import('kysely').Expression<any>} Condition.
 */
const isActiveAdmin = (eb, table = 'user') =>
  eb.and([
    eb(eb.fn.coalesce(`${table}.role`, eb.val('')), '=', 'admin'),
    eb(eb.fn.coalesce(`${table}.banned`, eb.val(0)), '=', 0),
  ]);

/**
 * Find a user by ID or username.
 * @param {Database} db Database.
 * @param {{ id: string } | { username: string }} by What to look up.
 * @returns {Promise<UserRow | null>} User.
 */
export const findUserRow = async (db, by) => {
  const query = db.selectFrom('user').selectAll();

  return (
    (await (
      'id' in by ? query.where('id', '=', by.id) : query.where('username', '=', by.username)
    ).executeTakeFirst()) ?? null
  );
};

/**
 * Count the admins who can sign in.
 * @param {Database} db Database.
 * @returns {Promise<number>} Count.
 */
export const countActiveAdminRows = async (db) => {
  const row = await db
    .selectFrom('user')
    .select(({ fn }) => fn.countAll().as('count'))
    .where((eb) => isActiveAdmin(eb))
    .executeTakeFirst();

  return Number(row?.count ?? 0);
};

/**
 * Condition that changing or deleting a user leaves an admin who can sign in: either they aren’t
 * one, or there is another.
 * @param {import('kysely').ExpressionBuilder<any, any>} eb Expression builder.
 * @returns {import('kysely').Expression<any>} Condition.
 */
const leavesAnAdmin = (eb) =>
  eb.or([
    eb.not(isActiveAdmin(eb)),
    eb(
      eb
        .selectFrom('user as a')
        .select(({ fn }) => fn.countAll().as('count'))
        .where((inner) => isActiveAdmin(inner, 'a')),
      '>',
      1,
    ),
  ]);

/**
 * Change a user’s role or disable them, unless that takes away the last admin who can sign in.
 * Checking and changing are one statement, so two admins demoting each other at once can’t leave
 * none.
 * @param {Database} db Database.
 * @param {string} id User ID.
 * @param {{ role?: string, banned?: boolean }} changes Changes.
 * @returns {Promise<boolean>} Whether the user was changed, `false` if they are the last admin or
 * don’t exist.
 */
export const updateUserAccessUnlessLastAdmin = async (db, id, { role, banned }) => {
  const removesAdmin = (role !== undefined && role !== 'admin') || banned === true;

  let query = db
    .updateTable('user')
    .set({
      ...(role === undefined ? {} : { role }),
      ...(banned === undefined ? {} : { banned: banned ? 1 : 0 }),
      // Better Auth’s own columns keep its date format
      updatedAt: new Date().toISOString(),
    })
    .where('id', '=', id);

  if (removesAdmin) {
    query = query.where(leavesAnAdmin);
  }

  return Number((await query.executeTakeFirst()).numUpdatedRows) > 0;
};

/**
 * Delete a user, unless they are the last admin who can sign in, in one statement like
 * {@link updateUserAccessUnlessLastAdmin}. Their sessions, accounts and GitHub identity go with
 * them.
 * @param {Database} db Database.
 * @param {string} id User ID.
 * @returns {Promise<boolean>} Whether the user was deleted, `false` if they are the last admin or
 * don’t exist.
 */
export const deleteUserUnlessLastAdmin = async (db, id) =>
  Number(
    (await db.deleteFrom('user').where('id', '=', id).where(leavesAnAdmin).executeTakeFirst())
      .numDeletedRows,
  ) > 0;

/**
 * List every user, oldest first, with what the user list shows about them.
 * @param {Database} db Database.
 * @param {string} provider ID of the site’s Git provider, whose identities are listed.
 * @returns {Promise<(UserRow & { lastSignInAt: number | null, hasPassword: number, githubLogin:
 * string | null, githubSignedInAt: number | null, ruleId: string | null })[]>} Users.
 */
export const listUserRows = (db, provider) =>
  db
    .selectFrom('user as u')
    .leftJoin('provider_account as g', (join) =>
      join.onRef('g.user_id', '=', 'u.id').on('g.provider', '=', provider),
    )
    .leftJoin('rule_member as r', 'r.user_id', 'u.id')
    .selectAll('u')
    .select((eb) => [
      eb
        .selectFrom('audit_log')
        .select(({ fn }) => fn.max('at').as('at'))
        .where('action', '=', 'auth.sign_in')
        .whereRef('actor_id', '=', 'u.id')
        .as('lastSignInAt'),
      eb
        .exists(
          eb
            .selectFrom('account')
            .select('id')
            .whereRef('userId', '=', 'u.id')
            .where('providerId', '=', 'credential'),
        )
        .as('hasPassword'),
      'g.login as githubLogin',
      'g.first_signed_in_at as githubSignedInAt',
      'r.rule_id as ruleId',
    ])
    .orderBy('u.createdAt')
    .execute();

/**
 * Check whether a user has a password, rather than only signing in with a provider.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<boolean>} Result.
 */
export const hasPasswordAccount = async (db, userId) =>
  !!(await db
    .selectFrom('account')
    .select('id')
    .where('userId', '=', userId)
    .where('providerId', '=', 'credential')
    .executeTakeFirst());

/**
 * Delete a user’s password, so they can only sign in with a provider.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const deletePasswordAccount = async (db, userId) => {
  await db
    .deleteFrom('account')
    .where('userId', '=', userId)
    .where('providerId', '=', 'credential')
    .execute();
};

/**
 * Delete every session, e.g. after a re-key, which leaves them invalid.
 * @param {Database} db Database.
 * @returns {Promise<void>}
 */
export const deleteAllSessions = async (db) => {
  await db.deleteFrom('session').execute();
};

/**
 * Find the sign-up rule that let a user in, until an admin adopts them.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<string | null>} Rule ID.
 */
export const findUserRuleId = async (db, userId) =>
  (
    await db
      .selectFrom('rule_member')
      .select('rule_id')
      .where('user_id', '=', userId)
      .executeTakeFirst()
  )?.rule_id ?? null;

/**
 * Find the sign-up rule that let a user in, with when their membership was last confirmed.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<{ rule_id: string, checked_at: number | null } | undefined>} Membership.
 */
export const findRuleMember = (db, userId) =>
  db
    .selectFrom('rule_member')
    .select(['rule_id', 'checked_at'])
    .where('user_id', '=', userId)
    .executeTakeFirst();

/**
 * Record that a member a sign-up rule let in still belongs to the organization.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const touchRuleMember = async (db, userId) => {
  await db
    .updateTable('rule_member')
    .set({ checked_at: Date.now() })
    .where('user_id', '=', userId)
    .execute();
};

/**
 * Record that a sign-up rule let a user in.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @param {string} ruleId Rule ID.
 * @returns {Promise<void>}
 */
export const insertRuleMember = async (db, userId, ruleId) => {
  await db
    .insertInto('rule_member')
    .values({ user_id: userId, rule_id: ruleId, created_at: Date.now(), checked_at: Date.now() })
    .execute();
};

/**
 * Forget that a sign-up rule let a user in, once an admin has adopted them.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @returns {Promise<void>}
 */
export const deleteRuleMember = async (db, userId) => {
  await db.deleteFrom('rule_member').where('user_id', '=', userId).execute();
};

/**
 * Check whether a session still exists, i.e. Hasn’t been ended.
 * @param {Database} db Database.
 * @param {string} sessionId Session ID.
 * @returns {Promise<boolean>} Result.
 */
export const sessionExists = async (db, sessionId) =>
  !!(await db.selectFrom('session').select('id').where('id', '=', sessionId).executeTakeFirst());
