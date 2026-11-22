/**
 * Storage of the comments on entries (`comment`), joined with their authors.
 * @import { Database } from '../../types.js';
 */

/**
 * A comment, as stored, with its author’s name, read live, so a renamed user shows up under the new
 * name everywhere.
 * @typedef {object} CommentRow
 * @property {string} id ID.
 * @property {string} entry_key Entry key.
 * @property {string | null} user_id Author, or `null` once deleted.
 * @property {string} body Markdown.
 * @property {number} created_at Creation date.
 * @property {number} updated_at Last edit date.
 * @property {string | null} name Author’s name.
 * @property {string | null} username Author’s username.
 * @property {string | null} image Author’s picture.
 */

/**
 * Start a query of comments joined with their authors.
 * @param {Database} db Database.
 * @returns {import('kysely').SelectQueryBuilder<any, any, CommentRow>} Query.
 */
const selectComments = (db) =>
  db
    .selectFrom('comment as c')
    .leftJoin('user as u', 'u.id', 'c.user_id')
    .selectAll('c')
    .select(['u.name', 'u.username', 'u.image']);

/**
 * Get a comment.
 * @param {Database} db Database.
 * @param {string} id ID.
 * @returns {Promise<CommentRow | undefined>} Comment.
 */
export const getCommentRow = (db, id) =>
  selectComments(db).where('c.id', '=', id).executeTakeFirst();

/**
 * List the comments on an entry, newest first, optionally only those older than a given one.
 * @param {Database} db Database.
 * @param {string} key Entry key.
 * @param {{ limit: number, before?: Pick<CommentRow, 'id' | 'created_at'> | null }} options
 * Options.
 * @returns {Promise<CommentRow[]>} Comments.
 */
export const listCommentRows = (db, key, { limit, before }) => {
  let query = selectComments(db).where('c.entry_key', '=', key);

  if (before) {
    query = query.where(({ or, and, eb }) =>
      or([
        eb('c.created_at', '<', before.created_at),
        and([eb('c.created_at', '=', before.created_at), eb('c.id', '<', before.id)]),
      ]),
    );
  }

  return query.orderBy('c.created_at', 'desc').orderBy('c.id', 'desc').limit(limit).execute();
};

/**
 * Count the comments on an entry.
 * @param {Database} db Database.
 * @param {string} key Entry key.
 * @returns {Promise<number>} Count.
 */
export const countCommentRows = async (db, key) => {
  const row = await db
    .selectFrom('comment')
    .select(({ fn }) => fn.countAll().as('count'))
    .where('entry_key', '=', key)
    .executeTakeFirst();

  return Number(row?.count ?? 0);
};

/**
 * Count the comments on every entry that has any.
 * @param {Database} db Database.
 * @returns {Promise<Record<string, number>>} Counts by entry key.
 */
export const countCommentsByKey = async (db) =>
  Object.fromEntries(
    (
      await db
        .selectFrom('comment')
        .select(({ fn }) => ['entry_key', fn.countAll().as('count')])
        .groupBy('entry_key')
        .execute()
    ).map(({ entry_key: key, count }) => [key, Number(count)]),
  );

/**
 * Add a comment, unless the entry has the given number of comments already. Counting and adding
 * are one statement, so concurrent requests can’t go over the limit.
 * @param {Database} db Database.
 * @param {{ id: string, entry_key: string, user_id: string, body: string }} comment Comment.
 * @param {number} max Most comments on one entry.
 * @returns {Promise<boolean>} Whether it was added.
 */
export const insertCommentIfRoom = async (db, comment, max) => {
  const now = Date.now();

  const result = await db
    .insertInto('comment')
    .columns(['id', 'entry_key', 'user_id', 'body', 'created_at', 'updated_at'])
    .expression(
      db
        .selectNoFrom((eb) => [
          eb.val(comment.id).as('id'),
          eb.val(comment.entry_key).as('entry_key'),
          eb.val(comment.user_id).as('user_id'),
          eb.val(comment.body).as('body'),
          eb.val(now).as('created_at'),
          eb.val(now).as('updated_at'),
        ])
        .where((eb) =>
          eb(
            eb
              .selectFrom('comment')
              .select(({ fn }) => fn.countAll().as('count'))
              .where('entry_key', '=', comment.entry_key),
            '<',
            max,
          ),
        ),
    )
    .executeTakeFirst();

  return Number(result.numInsertedOrUpdatedRows ?? 0) > 0;
};

/**
 * Change the text of a comment.
 * @param {Database} db Database.
 * @param {string} id ID.
 * @param {string} body New text.
 * @returns {Promise<void>}
 */
export const updateCommentBody = async (db, id, body) => {
  await db
    .updateTable('comment')
    .set({ body, updated_at: Date.now() })
    .where('id', '=', id)
    .execute();
};

/**
 * Delete a comment.
 * @param {Database} db Database.
 * @param {string} id ID.
 * @returns {Promise<void>}
 */
export const deleteCommentRow = async (db, id) => {
  await db.deleteFrom('comment').where('id', '=', id).execute();
};

/**
 * Move the comments of an entry to another key, unless that key has comments already, which would
 * be mixed up. Checking and moving are one statement, so a comment added in the meantime can’t be
 * mixed up either.
 * @param {Database} db Database.
 * @param {string} from Previous key.
 * @param {string} to New key, different from the previous one.
 * @returns {Promise<number>} Number of comments moved.
 */
export const moveCommentRows = async (db, from, to) => {
  const result = await db
    .updateTable('comment')
    .set({ entry_key: to })
    .where('entry_key', '=', from)
    .where(({ not, exists, selectFrom }) =>
      not(exists(selectFrom('comment as t').select('t.id').where('t.entry_key', '=', to))),
    )
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
};

/**
 * Delete the comments of an entry.
 * @param {Database} db Database.
 * @param {string} key Entry key.
 * @returns {Promise<void>}
 */
export const deleteEntryCommentRows = async (db, key) => {
  await db.deleteFrom('comment').where('entry_key', '=', key).execute();
};
