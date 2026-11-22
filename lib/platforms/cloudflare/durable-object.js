import { DurableObject } from 'cloudflare:workers';
import { Kysely } from 'kysely';

import { LATEST_SCHEMA_VERSION, migrations } from '../../../migrations/index.js';
import { createApp } from '../../core/app.js';
import { migrate } from '../../core/db/migrate.js';
import { getGitProvider } from '../../core/git-provider.js';
import { scheduleTokenRevocation } from '../../core/git-tokens.js';
import { errorResponse } from '../../core/http/errors.js';
import { runDueJobs } from '../../core/jobs.js';
import {
  GRACE_PERIOD,
  handleLockMessage,
  listLocks,
  orphanDeadLocks,
  orphanLocks,
  redeemTicket,
} from '../../core/locks.js';
import { handlePresenceMessage, listPresence, listViewers } from '../../core/presence.js';
import { github } from '../../git/github/index.js';

import { createSqlStorageDialect } from './kysely-dialect.js';
import { consumeRateLimit, createRateLimitTable, refundRateLimit } from './rate-limits.js';
import { addTenant, listTenants, removeTenant, updateTenant } from './registry.js';
import { createSqlRunner } from './sql-runner.js';
import { BASE_URL_HEADER, DEFAULT_TENANT, getRegistryObject, TENANT_HEADER } from './tenants.js';

/**
 * @import { Hono } from 'hono';
 * @import { LockClient } from '../../core/locks.js';
 * @import { PresenceClient } from '../../core/presence.js';
 * @import { Tenant } from './registry.js';
 * @import { AppEnv, Database, Platform, RateLimitResult, TenantContext } from '../../types.js';
 */

/**
 * Messages a lock connection may send per {@link MESSAGE_WINDOW}, beyond which it’s closed.
 */
const MESSAGE_LIMIT = 60;

/**
 * Window of the per-connection message limit.
 */
const MESSAGE_WINDOW = 10 * 1000;

/**
 * Close code for a connection that broke the rules, e.g. by sending too many messages.
 */
const POLICY_VIOLATION = 1008;

/**
 * Lock connections a user may keep open at once, one for each CMS tab.
 */
const MAX_CONNECTIONS_PER_USER = 10;

/**
 * Rate limit counters kept across every tenant, in the registry, rather than in each tenant: the
 * admin secret is the same for all of them, so counting attempts per tenant would let an attacker
 * multiply their guesses by the number of tenants.
 */
const GLOBAL_RATE_LIMIT_PREFIX = 'admin_secret:';

/**
 * Storage key of a retry of the token revocations, from before the jobs moved to the tenant’s
 * database, which the alarm moves there.
 */
const LEGACY_REVOCATION_AT_KEY = 'revocationAt';

/**
 * Git providers the Worker supports, the default first.
 */
const GIT_PROVIDERS = [github];

/**
 * Storage key of the tenant an instance holds, once it has been created.
 */
const TENANT_KEY = 'tenant';

/**
 * The one Durable Object class of the Worker. Keeping a single class means a new feature never
 * needs a class migration in the deployed `wrangler.jsonc`.
 *
 * Instances:
 * - `tenant:<ID>`: everything a tenant has. Its SQLite storage is the tenant’s database, so tenants
 * can never see each other’s data. It runs the app for the tenant’s requests, keeps a WebSocket per
 * CMS tab that can hibernate for the live updates, counts the tenant’s rate limits, and runs the
 * core’s background jobs (`core/jobs.js`) on its alarm. It’s the Cloudflare implementation of the
 * `Platform` interfaces in `lib/types.js`;
 * - `registry`: the list of tenants, and the rate limits shared by every tenant.
 */
export class AdditionsDurableObject extends DurableObject {
  /** Database over the instance’s SQLite storage. */
  db;

  /** The same storage, as Better Auth takes it. */
  authDatabase;

  /** @type {Hono<AppEnv> | undefined} */
  #app;

  /** @type {Promise<void> | undefined} */
  #schemaReady;

  /**
   * Tasks in progress, by key, so concurrent requests share one. Every request of the tenant runs
   * in this instance, so this covers them all.
   * @type {Map<string, Promise<any>>}
   */
  #tasks = new Map();

  /** Whether the tables the instance keeps for itself exist. */
  #localTablesReady = false;

  /**
   * Create an instance.
   * @param {DurableObjectState} ctx State.
   * @param {Record<string, any>} env Bindings.
   */
  constructor(ctx, env) {
    super(ctx, env);

    /** @type {Database} */
    this.db = new Kysely({ dialect: createSqlStorageDialect(ctx.storage.sql) });
    /** The same storage, for SQL written for SQLite: the migrations and the tests. */
    this.sqlRunner = createSqlRunner(ctx.storage);
    this.authDatabase = {
      dialect: createSqlStorageDialect(ctx.storage.sql),
      type: 'sqlite',
      transaction: false,
    };
  }

  /**
   * Create the table every instance keeps for itself, rather than in the tenant’s database: the
   * rate limits.
   */
  #createLocalTables() {
    if (this.#localTablesReady) {
      return;
    }

    this.#localTablesReady = true;
    createRateLimitTable(this.ctx.storage.sql);
  }

  /**
   * Apply the tenant’s pending migrations, once per instance. The registry never needs them.
   * @returns {Promise<void>}
   */
  ensureSchema() {
    this.#schemaReady ??= migrate(this.sqlRunner, migrations)
      .then((version) => {
        if (version < LATEST_SCHEMA_VERSION) {
          throw new Error(
            `Database schema is at version ${version}, not ${LATEST_SCHEMA_VERSION}.`,
          );
        }
      })
      .catch((error) => {
        // Retry on the next request
        this.#schemaReady = undefined;
        throw error;
      });

    return this.#schemaReady;
  }

  /**
   * Get the platform services the app uses, all backed by this instance.
   * @returns {Platform} Platform.
   */
  #createPlatform() {
    return {
      name: 'cloudflare',
      /**
       * Get the URL the tenant is reached at, which the Worker has set.
       * @param {Request} request Request.
       * @returns {string} URL.
       */
      getBaseURL: (request) => request.headers.get(BASE_URL_HEADER) ?? new URL(request.url).origin,
      /**
       * Get the tenant this instance holds, with its database migrated.
       * @returns {Promise<TenantContext>} Tenant.
       */
      resolveTenant: async () => {
        await this.ensureSchema();

        return { db: this.db, authDatabase: this.authDatabase };
      },
      rateLimits: {
        /**
         * Count a request against a rate limit, in the registry for one shared by every tenant.
         * @param {Record<string, any>} env Bindings.
         * @param {string} key Counter key.
         * @param {{ limit: number, windowSeconds: number }} options Options.
         * @returns {Promise<RateLimitResult>} Result.
         */
        consume: (env, key, { limit, windowSeconds }) =>
          key.startsWith(GLOBAL_RATE_LIMIT_PREFIX)
            ? getRegistryObject(env).consumeRateLimit(key, limit, windowSeconds)
            : Promise.resolve(this.consumeRateLimit(key, limit, windowSeconds)),
        /**
         * Take back a counted request.
         * @param {Record<string, any>} env Bindings.
         * @param {string} key Counter key.
         * @returns {Promise<void>}
         */
        refund: async (env, key) => {
          if (key.startsWith(GLOBAL_RATE_LIMIT_PREFIX)) {
            await getRegistryObject(env).refundRateLimit(key);
          } else {
            this.refundRateLimit(key);
          }
        },
      },
      scheduler: {
        /**
         * Set the alarm to go off by the given time.
         * @param {Record<string, any>} _env Bindings.
         * @param {number} at Time.
         * @returns {Promise<void>}
         */
        wakeAt: (_env, at) => this.#wakeAt(at),
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
        let running = this.#tasks.get(key);

        if (!running) {
          running = task().finally(() => {
            this.#tasks.delete(key);
          });
          this.#tasks.set(key, running);
        }

        return running;
      },
      realtime: {
        kind: 'websocket',
        /**
         * Open a tab’s connection.
         * @param {Record<string, any>} _env Bindings.
         * @param {Request} request WebSocket upgrade request.
         * @returns {Promise<Response>} Response.
         */
        connect: (_env, request) => this.#acceptLockConnection(request),
        /**
         * Send a message to every open tab of the tenant.
         * @param {Record<string, any>} _env Bindings.
         * @param {Record<string, any>} message Message.
         * @returns {Promise<void>}
         */
        broadcast: async (_env, message) => this.broadcast(message),
        /**
         * Close a user’s connections.
         * @param {Record<string, any>} _env Bindings.
         * @param {string} userId User ID.
         * @returns {Promise<void>}
         */
        disconnectUser: (_env, userId) => this.disconnectUser(userId),
      },
    };
  }

  /**
   * Answer a request for the tenant, which the Worker has routed here.
   * @param {Request} request Request, with the tenant and its URL in headers set by the Worker.
   * @returns {Promise<Response>} Response.
   */
  async fetch(request) {
    const tenant = request.headers.get(TENANT_HEADER);

    if (!tenant) {
      return errorResponse(400, 'tenant_missing', 'The request names no tenant.');
    }

    if (!(await this.ctx.storage.get(TENANT_KEY))) {
      // The default tenant exists without being created; any other is created by the operator
      if (tenant !== DEFAULT_TENANT) {
        return errorResponse(404, 'tenant_not_found', 'There is no such site.');
      }

      await this.ctx.storage.put(TENANT_KEY, { id: tenant, name: '' });
    }

    // Only now, so a request for a tenant that doesn’t exist leaves nothing behind
    this.#createLocalTables();
    this.#app ??= createApp(this.#createPlatform(), { gitProviders: GIT_PROVIDERS });

    return this.#app.fetch(request, this.env);
  }

  /**
   * Create the tenant this instance holds, so the Worker routes its requests here, unless it has
   * been created already, e.g. by a concurrent request.
   * @param {Tenant} tenant Tenant.
   * @returns {Promise<Tenant>} The tenant as created, which is another one if it existed already.
   */
  async createTenant(tenant) {
    const existing = /** @type {Tenant | undefined} */ (await this.ctx.storage.get(TENANT_KEY));

    if (existing) {
      return existing;
    }

    await this.ctx.storage.put(TENANT_KEY, tenant);

    return tenant;
  }

  /**
   * Check whether this instance holds a tenant that has been created.
   * @returns {Promise<boolean>} Result.
   */
  async hasTenant() {
    return !!(await this.ctx.storage.get(TENANT_KEY));
  }

  /**
   * Delete the tenant this instance holds, with all its data, and close its connections.
   * @returns {Promise<void>}
   */
  async deleteTenant() {
    this.ctx.getWebSockets().forEach((ws) => ws.close(1001, 'Site deleted'));
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // The instance may live on, and serve a tenant created again with the same ID. New database
    // objects leave every cache of the deleted tenant behind, as the caches are kept by database
    this.db = new Kysely({ dialect: createSqlStorageDialect(this.ctx.storage.sql) });
    this.sqlRunner = createSqlRunner(this.ctx.storage);
    this.authDatabase = {
      ...this.authDatabase,
      dialect: createSqlStorageDialect(this.ctx.storage.sql),
    };
    this.#app = undefined;
    this.#schemaReady = undefined;
    this.#localTablesReady = false;
  }

  /**
   * List the tenants, as the registry.
   * @returns {Tenant[]} Tenants, by ID.
   */
  listTenants() {
    return listTenants(this.ctx.storage.sql);
  }

  /**
   * Add a tenant to the registry.
   * @param {Tenant} tenant Tenant.
   * @returns {boolean} Whether it was added, rather than already there.
   */
  addTenant(tenant) {
    return addTenant(this.ctx.storage.sql, tenant);
  }

  /**
   * Replace a tenant’s details in the registry.
   * @param {Tenant} tenant Tenant.
   */
  updateTenant(tenant) {
    updateTenant(this.ctx.storage.sql, tenant);
  }

  /**
   * Remove a tenant from the registry.
   * @param {string} id Tenant ID.
   * @returns {boolean} Whether it was there.
   */
  removeTenant(id) {
    return removeTenant(this.ctx.storage.sql, id);
  }

  /**
   * List the open lock connections, as the clients they belong to.
   * @param {string} [except] Connection to leave out, e.g. one that is closing.
   * @returns {PresenceClient[]} Clients.
   */
  #listClients(except) {
    return (
      this.ctx
        .getWebSockets()
        .map(
          (ws) => /** @type {PresenceClient & { closed?: boolean }} */ (ws.deserializeAttachment()),
        )
        // A connection the instance has closed may still be listed until it’s gone
        .filter((client) => client && !client.closed && client.connection !== except)
    );
  }

  /**
   * Tell everyone who has an entry open now.
   * @param {string} key Entry key.
   * @param {string} [except] Connection to leave out, e.g. one that is closing.
   */
  #broadcastViewers(key, except) {
    this.broadcast({ type: 'presence', key, viewers: listViewers(this.#listClients(except), key) });
  }

  /**
   * Send a message to every lock connection.
   * @param {Record<string, any>} message Message.
   */
  broadcast(message) {
    const data = JSON.stringify(message);

    this.ctx.getWebSockets().forEach((ws) => {
      try {
        ws.send(data);
      } catch {
        // The connection is closing; its close handler takes care of it
      }
    });
  }

  /**
   * Close a user’s lock connections, e.g. once they’re disabled, signed out everywhere or given
   * another role. Their tabs connect again with a new ticket, which needs a valid session and
   * carries the current role, rather than keep acting with the one the connection was opened with.
   * Their entries are no longer open there, and their locks get the usual grace period.
   * @param {string} userId User ID.
   * @returns {Promise<void>}
   */
  async disconnectUser(userId) {
    const closing = this.ctx
      .getWebSockets()
      .filter((ws) => /** @type {PresenceClient} */ (ws.deserializeAttachment()).userId === userId);

    /** @type {Set<string>} */
    const openKeys = new Set();

    // Every one of the user’s connections is marked closed before anyone is told who has which
    // entry open, so none of them is still listed, and their close events change nothing more
    closing.forEach((ws) => {
      const client = /** @type {PresenceClient} */ (ws.deserializeAttachment());

      client.open?.forEach((key) => openKeys.add(key));
      ws.serializeAttachment({ ...client, closed: true });
    });
    openKeys.forEach((key) => this.#broadcastViewers(key));

    await Promise.all(
      closing.map(async (ws) => {
        const { connection } = /** @type {PresenceClient} */ (ws.deserializeAttachment());

        if (await orphanLocks(this.db, connection)) {
          await this.#wakeAt(Date.now() + GRACE_PERIOD);
        }

        try {
          ws.close(POLICY_VIOLATION, 'Access changed');
        } catch {
          // Already closed
        }
      }),
    );
  }

  /**
   * Start the grace period of the locks of connections that are gone without a close event, e.g.
   * after a restart, which the alarm then releases.
   * @returns {Promise<void>}
   */
  async #orphanDeadLocks() {
    if (await orphanDeadLocks(this.db, this.#listConnections())) {
      await this.#wakeAt(Date.now() + GRACE_PERIOD);
    }
  }

  /**
   * List the open connections.
   * @returns {string[]} Connection IDs.
   */
  #listConnections() {
    return this.ctx
      .getWebSockets()
      .map((ws) => /** @type {PresenceClient} */ (ws.deserializeAttachment()).connection);
  }

  /**
   * Open a lock connection with a ticket. The new connection gets a snapshot of every lock.
   * @param {Request} request WebSocket upgrade request, with the ticket in the `ticket` query.
   * @returns {Response} WebSocket response, or an error.
   */
  async #acceptLockConnection(request) {
    const user = await redeemTicket(this.db, new URL(request.url).searchParams.get('ticket'));

    if (!user) {
      return errorResponse(401, 'invalid_ticket', 'The ticket is invalid or has expired.');
    }

    // Each tab has a connection; more than a few for one user are no use but to flood the others
    const connections = this.ctx
      .getWebSockets()
      .filter(
        (ws) => /** @type {PresenceClient} */ (ws.deserializeAttachment()).userId === user.userId,
      );

    if (connections.length >= MAX_CONNECTIONS_PER_USER) {
      return errorResponse(429, 'too_many_connections', 'Close some of the open CMS tabs first.');
    }

    // Locks held by connections that are gone, e.g. before a restart, start their grace period, so
    // whoever held them, e.g. reconnecting now, can take them back
    await this.#orphanDeadLocks();

    const [client, server] = Object.values(new WebSocketPair());
    /** @type {LockClient} */
    const lockClient = { ...user, connection: crypto.randomUUID() };

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ...lockClient, windowStart: Date.now(), messages: 0 });
    server.send(
      JSON.stringify({
        type: 'snapshot',
        connection: lockClient.connection,
        user_id: lockClient.userId,
        locks: await listLocks(this.db),
        presence: listPresence(this.#listClients(lockClient.connection)),
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle a message from a lock connection.
   * @param {WebSocket} ws Connection.
   * @param {string | ArrayBuffer} data Message.
   * @returns {Promise<void>}
   */
  async webSocketMessage(ws, data) {
    const attachment = ws.deserializeAttachment();
    const now = Date.now();

    // A connection the instance has closed, or one of a tenant deleted meanwhile
    if (attachment.closed || !(await this.#prepareStorage())) {
      return;
    }

    if (now - attachment.windowStart >= MESSAGE_WINDOW) {
      Object.assign(attachment, { windowStart: now, messages: 0 });
    }

    attachment.messages += 1;
    ws.serializeAttachment(attachment);

    if (attachment.messages > MESSAGE_LIMIT) {
      ws.close(POLICY_VIOLATION, 'Too many messages');

      return;
    }

    // Who has an entry open is kept with the connection, not in the database
    const presence = handlePresenceMessage(attachment, data);

    if (presence) {
      if (presence.open) {
        attachment.open = presence.open;
        ws.serializeAttachment(attachment);
      }

      if (presence.error) {
        ws.send(JSON.stringify({ type: 'error', code: presence.error }));
      } else if (presence.key) {
        this.#broadcastViewers(presence.key);
      }

      return;
    }

    const { reply, broadcast } = await handleLockMessage(this.db, attachment, data, now);

    reply.forEach((message) => ws.send(JSON.stringify(message)));
    broadcast.forEach((message) => this.broadcast(message));
  }

  /**
   * Keep the locks of a closed connection for a grace period, so a reload doesn’t lose them, but
   * tell everyone at once that its entries are no longer open there.
   * @param {WebSocket} ws Connection.
   * @returns {Promise<void>}
   */
  async webSocketClose(ws) {
    const {
      connection,
      open = [],
      closed,
    } = /** @type {PresenceClient & { closed?: boolean }} */ (ws.deserializeAttachment());

    // Closed by the instance, which has dealt with it already, or of a tenant deleted meanwhile
    if (closed || !(await this.#prepareStorage())) {
      return;
    }

    open.forEach((key) => this.#broadcastViewers(key, connection));

    if (await orphanLocks(this.db, connection)) {
      await this.#wakeAt(Date.now() + GRACE_PERIOD);
    }
  }

  /**
   * Treat a failed connection like a closed one.
   * @param {WebSocket} ws Connection.
   * @returns {Promise<void>}
   */
  webSocketError(ws) {
    return this.webSocketClose(ws);
  }

  /**
   * Make sure the alarm goes off by the given time. The background jobs share the one alarm, which
   * runs whatever is due and sets itself for the next job.
   * @param {number} at Time.
   * @returns {Promise<void>}
   */
  async #wakeAt(at) {
    // A request still running for a tenant deleted meanwhile mustn’t bring its storage back
    if (!(await this.ctx.storage.get(TENANT_KEY))) {
      return;
    }

    const current = await this.ctx.storage.getAlarm();

    if (current === null || current > at) {
      await this.ctx.storage.setAlarm(at);
    }
  }

  /**
   * Make sure the tenant still exists and its database is migrated, before an event that doesn’t
   * come through the app, e.g. a WebSocket message, uses it.
   * @returns {Promise<boolean>} Whether the tenant exists.
   */
  async #prepareStorage() {
    if (!(await this.ctx.storage.get(TENANT_KEY))) {
      return false;
    }

    this.#createLocalTables();
    await this.ensureSchema();

    return true;
  }

  /**
   * Run the background jobs that are due, then set the alarm for the next one, if any.
   * @returns {Promise<void>}
   */
  async alarm() {
    // An alarm left by a tenant deleted meanwhile
    if (!(await this.ctx.storage.get(TENANT_KEY))) {
      return;
    }

    this.#createLocalTables();
    await this.ensureSchema();
    await this.#moveLegacyRevocation();

    const next = await runDueJobs({
      db: this.db,
      adminSecret: this.env.ADMIN_SECRET,
      gitProvider: await getGitProvider(this.db, GIT_PROVIDERS),
      liveConnections: this.#listConnections(),
      /**
       * Send a message to every open tab.
       * @param {Record<string, any>} message Message.
       * @returns {void}
       */
      broadcast: (message) => this.broadcast(message),
    });

    if (next !== null) {
      await this.#wakeAt(next);
    }
  }

  /**
   * Move a retry of the token revocations scheduled before the jobs moved to the tenant’s database.
   * @returns {Promise<void>}
   */
  async #moveLegacyRevocation() {
    if ((await this.ctx.storage.get(LEGACY_REVOCATION_AT_KEY)) === undefined) {
      return;
    }

    await scheduleTokenRevocation(this.db);
    await this.ctx.storage.delete([LEGACY_REVOCATION_AT_KEY, 'revocationAttempts']);
  }

  /**
   * Take back a request counted with {@link consumeRateLimit}, e.g. a successful attempt where only
   * failures should count.
   * @param {string} key Counter key.
   */
  refundRateLimit(key) {
    this.#createLocalTables();
    refundRateLimit(this.ctx.storage.sql, key);
  }

  /**
   * Count a request against a fixed-window rate limit.
   * @param {string} key Counter key.
   * @param {number} limit Requests allowed per window.
   * @param {number} windowSeconds Window length.
   * @returns {RateLimitResult} Result.
   */
  consumeRateLimit(key, limit, windowSeconds) {
    this.#createLocalTables();

    return consumeRateLimit(this.ctx.storage.sql, { key, limit, windowSeconds });
  }
}
