import { DatabaseSync } from 'node:sqlite';

import { Kysely } from 'kysely';

import { LATEST_SCHEMA_VERSION, migrations } from '../../../migrations/index.js';
import { migrate } from '../../core/db/migrate.js';
import { getGitProvider } from '../../core/git-provider.js';
import { runDueJobs } from '../../core/jobs.js';
import { github } from '../../git/github/index.js';

import { createNodeSqliteDialect, createNodeSqliteRunner } from './sqlite.js';

/**
 * A platform that keeps everything in one Node process: a single tenant in an in-memory SQLite
 * database, rate limits in a map, background jobs run by hand, and, optionally, live updates that
 * are only recorded. It runs the core on Node, for the tests, and shows what a platform provides.
 * @import { Platform, RateLimitResult, Realtime } from '../../types.js';
 * @import { GitProvider } from '../../core/git-provider.js';
 */

/**
 * A message sent to the open tabs, as recorded.
 * @typedef {{ type: 'broadcast', message: Record<string, any> } |
 * { type: 'disconnect', userId: string }} RecordedMessage
 */

/**
 * Create an in-memory platform.
 * @param {object} [options] Options.
 * @param {boolean} [options.realtime] Whether to have live updates, which are recorded in
 * `messages` rather than sent. Without them, the CMS polls.
 * @param {(message: Record<string, any>) => void} [options.onBroadcast] Function called with every
 * message sent to the open tabs.
 * @param {GitProvider[]} [options.gitProviders] Git providers, the default first; GitHub by
 * default.
 * @returns {{ platform: Platform, gitProviders: GitProvider[], database: DatabaseSync,
 * wakeUps: number[],
 * messages: RecordedMessage[], runJobs: (env: Record<string, any>) => Promise<number | null>,
 * reset: () => void }} The platform, its database, the times it was asked to run the jobs by and
 * the messages sent to the tabs, a function that runs the jobs, and one that forgets the rate
 * limits, wake-ups and messages.
 */
export const createMemoryPlatform = ({
  realtime = false,
  onBroadcast,
  gitProviders = [github],
} = {}) => {
  const database = new DatabaseSync(':memory:');
  const db = new Kysely({ dialect: createNodeSqliteDialect(database) });
  const authDatabase = { dialect: createNodeSqliteDialect(database), type: 'sqlite' };
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const counters = new Map();
  /** @type {Map<string, Promise<any>>} */
  const tasks = new Map();
  /** @type {number[]} */
  const wakeUps = [];
  /** @type {RecordedMessage[]} */
  const messages = [];
  /** @type {Promise<void> | undefined} */
  let schemaReady;

  /**
   * Apply the pending migrations, once.
   * @returns {Promise<void>}
   */
  const ensureSchema = () => {
    schemaReady ??= migrate(createNodeSqliteRunner(database), migrations)
      .then((version) => {
        if (version < LATEST_SCHEMA_VERSION) {
          throw new Error(
            `Database schema is at version ${version}, not ${LATEST_SCHEMA_VERSION}.`,
          );
        }
      })
      .catch((error) => {
        // Retry on the next request
        schemaReady = undefined;
        throw error;
      });

    return schemaReady;
  };

  /** @type {Realtime} */
  const recorder = {
    kind: 'websocket',
    /**
     * Connections can’t be opened in memory.
     * @returns {Promise<Response>} Error.
     */
    connect: async () => new Response(null, { status: 501 }),
    /**
     * Record a message to every tab.
     * @param {Record<string, any>} _env Bindings.
     * @param {Record<string, any>} message Message.
     * @returns {Promise<void>}
     */
    broadcast: async (_env, message) => {
      messages.push({ type: 'broadcast', message });
      onBroadcast?.(message);
    },
    /**
     * Record that a user’s connections were closed.
     * @param {Record<string, any>} _env Bindings.
     * @param {string} userId User ID.
     * @returns {Promise<void>}
     */
    disconnectUser: async (_env, userId) => {
      messages.push({ type: 'disconnect', userId });
    },
  };

  /** @type {Platform} */
  const platform = {
    name: 'memory',
    /**
     * Get the URL the service is reached at: the request’s origin.
     * @param {Request} request Request.
     * @returns {string} URL.
     */
    getBaseURL: (request) => new URL(request.url).origin,
    /**
     * Get the one tenant, with its database migrated.
     * @returns {Promise<import('../../types.js').TenantContext>} Tenant.
     */
    resolveTenant: async () => {
      await ensureSchema();

      return { db, authDatabase };
    },
    rateLimits: {
      /**
       * Count a request against a fixed-window rate limit.
       * @param {Record<string, any>} _env Bindings.
       * @param {string} key Counter key.
       * @param {{ limit: number, windowSeconds: number }} options Options.
       * @returns {Promise<RateLimitResult>} Result.
       */
      consume: async (_env, key, { limit, windowSeconds }) => {
        const now = Date.now();
        let counter = counters.get(key);

        if (!counter || counter.resetAt <= now) {
          counter = { count: 0, resetAt: now + windowSeconds * 1000 };
          counters.set(key, counter);
        }

        if (counter.count >= limit) {
          return { allowed: false, retryAfter: Math.ceil((counter.resetAt - now) / 1000) };
        }

        counter.count += 1;

        return { allowed: true, retryAfter: 0 };
      },
      /**
       * Take back a counted request.
       * @param {Record<string, any>} _env Bindings.
       * @param {string} key Counter key.
       * @returns {Promise<void>}
       */
      refund: async (_env, key) => {
        const counter = counters.get(key);

        if (counter && counter.count > 0) {
          counter.count -= 1;
        }
      },
    },
    scheduler: {
      /**
       * Record when the jobs should run by; the caller runs them with `runJobs`.
       * @param {Record<string, any>} _env Bindings.
       * @param {number} at Time.
       * @returns {Promise<void>}
       */
      wakeAt: async (_env, at) => {
        wakeUps.push(at);
      },
    },
    /**
     * Run a task, sharing it with the calls for the same key made while it runs.
     * @template T
     * @param {Record<string, any>} _env Bindings.
     * @param {string} key Key.
     * @param {() => Promise<T>} task Task.
     * @returns {Promise<T>} Result.
     */
    runOnce: (_env, key, task) => {
      let running = tasks.get(key);

      if (!running) {
        running = task().finally(() => {
          tasks.delete(key);
        });
        tasks.set(key, running);
      }

      return running;
    },
    realtime: realtime ? recorder : null,
  };

  return {
    platform,
    gitProviders,
    database,
    wakeUps,
    messages,
    /**
     * Run the background jobs, as a scheduled function would.
     * @param {Record<string, any>} env Bindings.
     * @returns {Promise<number | null>} When the next job is due, if any.
     */
    runJobs: async (env) => {
      await ensureSchema();

      return runDueJobs({
        db,
        adminSecret: env.ADMIN_SECRET,
        gitProvider: await getGitProvider(db, gitProviders),
        ...(realtime
          ? {
              // Connections can’t be opened in memory, so none is open
              liveConnections: [],
              /**
               * Record a message to every tab.
               * @param {Record<string, any>} message Message.
               * @returns {Promise<void>}
               */
              broadcast: (message) => recorder.broadcast(env, message),
            }
          : {}),
      });
    },
    /**
     * Forget the rate limits, wake-ups and messages.
     */
    reset: () => {
      counters.clear();
      wakeUps.length = 0;
      messages.length = 0;
    },
  };
};
