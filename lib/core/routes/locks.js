import { requireSession } from '../auth/session.js';
import { toPublicUser } from '../auth/users.js';
import { readJson } from '../http/body.js';
import { HttpError } from '../http/errors.js';
import {
  acquireLock,
  createTicket,
  GRACE_PERIOD,
  listLocks,
  orphanLocks,
  releaseLock,
  takeOverLock,
  TICKET_TTL,
} from '../locks.js';
import {
  isLiveConnection,
  listHeartbeatClients,
  listPresence,
  recordHeartbeat,
} from '../presence.js';
import { consumeRateLimits } from '../rate-limit.js';
import { deletePresenceRows } from '../store/presence.js';

/**
 * @import { Hono } from 'hono';
 * @import { AppEnv, Platform } from '../../types.js';
 */

/**
 * Rate limit on socket tickets, per user.
 */
const TICKET_LIMIT = { limit: 60, windowSeconds: 600 };

/**
 * Rate limit on heartbeats and lock changes, per user, where tabs poll instead of keeping a
 * connection open: a heartbeat every 15 seconds from each of a few tabs, plus the lock changes.
 */
const POLL_LIMIT = { limit: 600, windowSeconds: 600 };

/**
 * Register the endpoints that stand in for the socket where the platform has no live updates: each
 * CMS tab sends a heartbeat with the entries it has open, which returns every lock and who has which
 * entry open, and acquires, takes over and releases locks with requests of its own.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
const registerPollingRoutes = (app, platform) => {
  app.use('/v1/presence', requireSession(platform));
  app.use('/v1/presence/*', requireSession(platform));

  app.post('/v1/presence', async (c) => {
    const { id, name, role } = toPublicUser(c.get('user'));
    const { connection, open } = await readJson(c);
    const db = c.get('db');

    await consumeRateLimits(platform, c.env, [{ key: `poll:user:${id}`, ...POLL_LIMIT }]);

    const error = await recordHeartbeat(db, { userId: id, name, role }, connection, open);

    if (error) {
      throw new HttpError(400, error, 'The heartbeat is invalid.');
    }

    return c.json({
      locks: await listLocks(db),
      presence: listPresence(await listHeartbeatClients(db)),
    });
  });

  // A tab closes: its entries are no longer open, and its locks get the grace period
  app.delete('/v1/presence/:connection', async (c) => {
    const { id } = toPublicUser(c.get('user'));
    const connection = c.req.param('connection');
    const db = c.get('db');

    if (await isLiveConnection(db, id, connection)) {
      await deletePresenceRows(db, { connection });

      // The jobs release them once the grace period is over
      if (await orphanLocks(db, connection)) {
        await platform.scheduler.wakeAt(c.env, Date.now() + GRACE_PERIOD);
      }
    }

    return c.json({ closed: true });
  });

  app.post('/v1/locks', requireSession(platform), async (c) => {
    const { id, name, role } = toPublicUser(c.get('user'));
    const { type, key, connection } = await readJson(c);
    const db = c.get('db');

    await consumeRateLimits(platform, c.env, [{ key: `poll:user:${id}`, ...POLL_LIMIT }]);

    // A lock belongs to a tab, which must be the user’s and still send heartbeats
    if (!(await isLiveConnection(db, id, connection))) {
      throw new HttpError(409, 'invalid_connection', 'Send a heartbeat for this tab first.');
    }

    const client = { connection, userId: id, name, role };

    if (type === 'release') {
      return c.json({ released: await releaseLock(db, client, key) });
    }

    if (type !== 'acquire' && type !== 'takeover') {
      throw new HttpError(400, 'invalid_message', '`type` must be acquire, takeover or release.');
    }

    const outcome = await (type === 'acquire' ? acquireLock : takeOverLock)(db, client, key);

    if (!outcome.ok) {
      return c.json(
        {
          error: { code: outcome.reason, message: 'The lock can’t be acquired.' },
          ...(outcome.lock ? { lock: outcome.lock } : {}),
        },
        { held: 409, too_many_locks: 409, forbidden: 403, invalid_key: 400 }[outcome.reason],
      );
    }

    return c.json({ lock: outcome.lock });
  });
};

/**
 * Register the socket the CMS keeps open for entry locks and comment updates, and the lock list.
 * The CMS gets a ticket with its session, then opens the WebSocket with it, since browsers can’t
 * set headers on one.
 * @param {Hono<AppEnv>} app App.
 * @param {Platform} platform Platform services.
 */
export const registerLockRoutes = (app, platform) => {
  if (!platform.realtime) {
    registerPollingRoutes(app, platform);
  }

  app.post('/v1/socket/ticket', requireSession(platform), async (c) => {
    const { id, name, role } = toPublicUser(c.get('user'));

    // A tab asks again after a reconnection; far more often is someone opening connections to flood
    // the others, which the number of connections per user limits too
    await consumeRateLimits(platform, c.env, [
      { key: `socket_ticket:user:${id}`, ...TICKET_LIMIT },
    ]);

    const ticket = await createTicket(c.get('db'), { userId: id, name, role });

    return c.json({ ticket, expires_in: TICKET_TTL / 1000 });
  });

  app.get('/v1/locks', requireSession(platform), async (c) =>
    c.json({ locks: await listLocks(c.get('db')) }),
  );

  // The CORS middleware has checked the origin against the allowed domains already
  app.get('/v1/socket', async (c) => {
    if (!platform.realtime) {
      throw new HttpError(404, 'realtime_unavailable', 'This deployment has no live updates.');
    }

    if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
      throw new HttpError(426, 'upgrade_required', 'Connect with a WebSocket.');
    }

    const response = await platform.realtime.connect(c.env, c.req.raw);

    // An error from another context has immutable headers, which CORS has to add to
    return response.status === 101 ? response : new Response(response.body, response);
  });
};
