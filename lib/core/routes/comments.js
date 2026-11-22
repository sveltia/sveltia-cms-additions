import { logAudit } from '../audit.js';
import { requireEditor, requireSession } from '../auth/session.js';
import { toPublicUser } from '../auth/users.js';
import {
  createComment,
  listComments,
  renameComments,
  requireComment,
  updateComment,
  validateBody,
  validateKey,
} from '../comments.js';
import { readJson } from '../http/body.js';
import { consumeRateLimits } from '../rate-limit.js';
import {
  countCommentRows,
  countCommentsByKey,
  deleteCommentRow,
  deleteEntryCommentRows,
} from '../store/comments.js';

/**
 * @import { Context, Hono } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * Rate limit on adding, editing and deleting comments, per user.
 */
const WRITE_LIMIT = { limit: 30, windowSeconds: 60 };

/**
 * Register the comment endpoints. Every role can read and write comments, viewers included, while
 * moving and deleting an entry’s comments follows the entry, which only editors and admins can
 * change.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerCommentRoutes = (app, platform) => {
  app.use('/v1/comments', requireSession(platform));
  app.use('/v1/comments/*', requireSession(platform));

  /**
   * Get the user asking.
   * @param {Context<AppEnv>} c Hono context.
   * @returns {{ id: string, role: string }} User.
   */
  const getViewer = (c) => toPublicUser(c.get('user'));

  /**
   * Count a write against the user’s rate limit.
   * @param {Context<AppEnv>} c Hono context.
   * @returns {Promise<void>}
   */
  const limitWrites = async (c) => {
    await consumeRateLimits(platform, c.env, [
      { key: `comments:user:${c.get('user').id}`, ...WRITE_LIMIT },
    ]);
  };

  /**
   * Tell every open CMS tab how many comments an entry has now, so an open panel can reload and a
   * badge can update.
   * @param {Context<AppEnv>} c Hono context.
   * @param {string} key Entry key.
   * @returns {Promise<void>}
   */
  const announce = async (c, key) => {
    await platform.realtime?.broadcast(c.env, {
      type: 'comments',
      key,
      count: await countCommentRows(c.get('db'), key),
    });
  };

  app.get('/v1/comments', async (c) =>
    c.json(
      await listComments(
        c.get('db'),
        validateKey(c.req.query('key')),
        getViewer(c),
        c.req.query('before'),
      ),
    ),
  );

  app.get('/v1/comments/counts', async (c) =>
    c.json({ counts: await countCommentsByKey(c.get('db')) }),
  );

  app.post('/v1/comments', async (c) => {
    const body = await readJson(c);
    const key = validateKey(body.key);
    const text = validateBody(body.body);

    await limitWrites(c);

    const comment = await createComment(c.get('db'), { key, body: text, viewer: getViewer(c) });

    await announce(c, key);

    return c.json({ comment }, 201);
  });

  app.patch('/v1/comments/:id', async (c) => {
    const db = c.get('db');
    const viewer = getViewer(c);
    const text = validateBody((await readJson(c)).body);
    const row = await requireComment(db, c.req.param('id'), viewer, 'edit');

    await limitWrites(c);

    const comment = await updateComment(db, row.id, text, viewer);

    await announce(c, row.entry_key);

    return c.json({ comment });
  });

  app.delete('/v1/comments/:id', async (c) => {
    const db = c.get('db');
    const viewer = getViewer(c);
    const row = await requireComment(db, c.req.param('id'), viewer, 'delete');

    await limitWrites(c);
    await deleteCommentRow(db, row.id);

    // An admin removing someone else’s comment is recorded
    if (row.user_id !== viewer.id) {
      await logAudit(db, {
        action: 'comment.delete',
        actorId: viewer.id,
        target: row.user_id,
        meta: { key: row.entry_key },
      });
    }

    await announce(c, row.entry_key);

    return c.json({ deleted: true });
  });

  // After an entry’s slug or file name has changed, its comments follow it
  app.post('/v1/comments/rename', async (c) => {
    requireEditor(c);

    const body = await readJson(c);
    const from = validateKey(body.from);
    const to = validateKey(body.to);
    const moved = await renameComments(c.get('db'), from, to);

    await announce(c, from);
    await announce(c, to);

    return c.json({ moved });
  });

  // After an entry has been deleted, or a draft that was never published discarded
  app.delete('/v1/comments', async (c) => {
    requireEditor(c);

    const key = validateKey(c.req.query('key'));

    await deleteEntryCommentRows(c.get('db'), key);
    await announce(c, key);

    return c.json({ deleted: true });
  });
};
