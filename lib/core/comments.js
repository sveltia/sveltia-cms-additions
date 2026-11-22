import { HttpError } from './http/errors.js';
import {
  countCommentRows,
  getCommentRow,
  insertCommentIfRoom,
  listCommentRows,
  moveCommentRows,
  updateCommentBody,
} from './store/comments.js';

/**
 * Comments on entries, kept by the service for the CMS’s users only.
 */

/**
 * @import { Database } from '../types.js';
 * @import { CommentRow } from './store/comments.js';
 */

/**
 * Longest entry key: a collection name and an entry slug or file name.
 */
export const MAX_KEY_LENGTH = 512;

/**
 * Longest comment, in characters.
 */
export const MAX_BODY_LENGTH = 10_000;

/**
 * Most comments on one entry.
 */
export const MAX_COMMENTS_PER_KEY = 1000;

/**
 * Most comments returned at once, the newest ones.
 */
export const PAGE_SIZE = 500;

/**
 * A comment as the API returns it.
 * @typedef {object} PublicComment
 * @property {string} id ID.
 * @property {string} key Entry key.
 * @property {string} body Markdown.
 * @property {{ id: string, name: string, username: string, image: string | null } | null} author
 * Author, or `null` once deleted.
 * @property {string} created_at Creation date, as ISO 8601.
 * @property {string} updated_at Last edit date, as ISO 8601.
 * @property {boolean} can_edit Whether the user asking can edit it: only its author can.
 * @property {boolean} can_delete Whether the user asking can delete it: its author or an admin.
 */

/**
 * Check an entry key.
 * @param {unknown} value Value.
 * @returns {string} Key.
 * @throws {HttpError} If it’s invalid.
 */
export const validateKey = (value) => {
  if (typeof value !== 'string' || !value || value.length > MAX_KEY_LENGTH) {
    throw new HttpError(400, 'invalid_key', 'An entry key of up to 512 characters is required.');
  }

  return value;
};

/**
 * Check a comment body.
 * @param {unknown} value Value.
 * @returns {string} Body.
 * @throws {HttpError} If it’s empty or too long.
 */
export const validateBody = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_BODY_LENGTH) {
    throw new HttpError(
      400,
      'invalid_comment',
      'A comment needs some text, and can have up to 10,000 characters.',
    );
  }

  return value;
};

/**
 * Convert a stored comment for the API.
 * @param {CommentRow} row Row, joined with its author.
 * @param {{ id: string, role: string }} viewer User asking.
 * @returns {PublicComment} Comment.
 */
const toPublicComment = (row, viewer) => ({
  id: row.id,
  key: row.entry_key,
  body: row.body,
  author: row.user_id
    ? { id: row.user_id, name: row.name, username: row.username, image: row.image ?? null }
    : null,
  created_at: new Date(row.created_at).toISOString(),
  updated_at: new Date(row.updated_at).toISOString(),
  can_edit: !!row.user_id && row.user_id === viewer.id,
  can_delete: (!!row.user_id && row.user_id === viewer.id) || viewer.role === 'admin',
});

/**
 * List the comments on an entry, oldest first: the newest {@link PAGE_SIZE}, or those before a
 * given comment.
 * @param {Database} db Database.
 * @param {string} key Entry key.
 * @param {{ id: string, role: string }} viewer User asking.
 * @param {string} [before] ID of a comment to list the older ones of.
 * @returns {Promise<{ comments: PublicComment[], has_more: boolean }>} Comments, and whether there
 * are older ones.
 * @throws {HttpError} If the comment to list the older ones of isn’t on the entry, e.g. as it has
 * been deleted since, rather than list the newest again.
 */
export const listComments = async (db, key, viewer, before) => {
  const anchor = before ? await getCommentRow(db, before) : null;

  if (before && anchor?.entry_key !== key) {
    throw new HttpError(404, 'comment_not_found', 'There is no such comment.');
  }

  const rows = await listCommentRows(db, key, { limit: PAGE_SIZE + 1, before: anchor });

  return {
    comments: rows
      .slice(0, PAGE_SIZE)
      .reverse()
      .map((row) => toPublicComment(row, viewer)),
    has_more: rows.length > PAGE_SIZE,
  };
};

/**
 * Add a comment.
 * @param {Database} db Database.
 * @param {{ key: string, body: string, viewer: { id: string, role: string } }} args Arguments.
 * @returns {Promise<PublicComment>} Comment.
 * @throws {HttpError} If the entry has too many comments.
 */
export const createComment = async (db, { key, body, viewer }) => {
  const id = crypto.randomUUID();

  if (
    !(await insertCommentIfRoom(
      db,
      { id, entry_key: key, user_id: viewer.id, body },
      MAX_COMMENTS_PER_KEY,
    ))
  ) {
    throw new HttpError(409, 'too_many_comments', 'This entry has too many comments.');
  }

  return toPublicComment(/** @type {CommentRow} */ (await getCommentRow(db, id)), viewer);
};

/**
 * Get a comment the user may change.
 * @param {Database} db Database.
 * @param {string} id ID.
 * @param {{ id: string, role: string }} viewer User asking.
 * @param {'edit' | 'delete'} action What they want to do.
 * @returns {Promise<CommentRow>} Row.
 * @throws {HttpError} If there is no such comment, or the user may not change it.
 */
export const requireComment = async (db, id, viewer, action) => {
  const row = await getCommentRow(db, id);

  if (!row) {
    throw new HttpError(404, 'comment_not_found', 'There is no such comment.');
  }

  const comment = toPublicComment(row, viewer);

  if (action === 'edit' ? !comment.can_edit : !comment.can_delete) {
    throw new HttpError(403, 'forbidden', 'Only the author can change a comment.');
  }

  return row;
};

/**
 * Edit a comment.
 * @param {Database} db Database.
 * @param {string} id ID.
 * @param {string} body New body.
 * @param {{ id: string, role: string }} viewer User asking.
 * @returns {Promise<PublicComment>} Comment.
 */
export const updateComment = async (db, id, body, viewer) => {
  await updateCommentBody(db, id, body);

  const row = await getCommentRow(db, id);

  // Deleted meanwhile
  if (!row) {
    throw new HttpError(404, 'comment_not_found', 'There is no such comment.');
  }

  return toPublicComment(row, viewer);
};

/**
 * Move the comments of an entry to its new key, after its slug or file name has changed.
 * @param {Database} db Database.
 * @param {string} from Previous key.
 * @param {string} to New key.
 * @returns {Promise<number>} Number of comments moved.
 * @throws {HttpError} If the new key has comments already, which would be mixed up.
 */
export const renameComments = async (db, from, to) => {
  if (from === to) {
    return countCommentRows(db, from);
  }

  const moved = await moveCommentRows(db, from, to);

  // Nothing moved: either there was nothing to move, which is fine, or the new key has comments
  // already, which would be mixed up
  if (!moved && (await countCommentRows(db, from)) && (await countCommentRows(db, to))) {
    throw new HttpError(409, 'comments_exist', 'The new entry has comments already.');
  }

  return moved;
};
