import { retryTokenRevocation } from './git-tokens.js';
import { expireLocks, orphanDeadLocks } from './locks.js';
import { listHeartbeatClients } from './presence.js';
import { getNextJobDueAt } from './store/jobs.js';

/**
 * Background jobs: releasing the locks of closed connections, and retrying the token revocations
 * GitHub didn’t take. A platform runs {@link runDueJobs} when its scheduler says they’re due, e.g.
 * from a Durable Object alarm or a cron job; running it more often is harmless.
 * @import { Database } from '../types.js';
 * @import { GitProvider } from './git-provider.js';
 */

/**
 * What a run of the jobs needs from the platform.
 * @typedef {object} JobContext
 * @property {Database} db The tenant’s database.
 * @property {string | undefined} adminSecret `ADMIN_SECRET`, which unlocks the data key.
 * @property {GitProvider} gitProvider The site’s Git provider, which revokes its tokens.
 * @property {string[]} [liveConnections] Connections still open, where the platform keeps them,
 * so the locks of those gone without closing, e.g. after a restart, start their grace period.
 * Without them, the tabs that still send heartbeats are.
 * @property {(message: Record<string, any>) => Promise<void> | void} [broadcast] Send a message to
 * every open tab, where the platform has live updates.
 */

/**
 * Run the jobs that are due: retry the token revocations, then release the locks whose grace
 * period is over, telling every open tab.
 * @param {JobContext} context Context.
 * @returns {Promise<number | null>} When the next job is due, if any.
 */
export const runDueJobs = async (context) => {
  const { db, adminSecret, gitProvider, liveConnections, broadcast } = context;

  await retryTokenRevocation(db, adminSecret, gitProvider);

  // Only after waiting for GitHub, as a tab may have closed meanwhile, orphaning its locks
  await orphanDeadLocks(
    db,
    liveConnections ?? (await listHeartbeatClients(db)).map(({ connection }) => connection),
  );

  const { released, next: nextLock } = await expireLocks(db);

  await Promise.all(released.map((key) => broadcast?.({ type: 'changed', key, lock: null })));

  const next = [nextLock, await getNextJobDueAt(db)].filter((at) => at !== null);

  return next.length ? Math.min(...next) : null;
};
