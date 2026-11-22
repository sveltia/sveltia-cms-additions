import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { Kysely } from 'kysely';

import { createSqliteDialect } from '../platforms/cloudflare/kysely-dialect.js';
import {
  DEFAULT_TENANT,
  getRegistryObject,
  getTenantObject,
} from '../platforms/cloudflare/tenants.js';

/**
 * What the tests run against on Cloudflare: the Worker, with the default tenant’s Durable Object.
 * The Node project of the tests swaps this module for `harness.node.js`, which runs the core on the
 * in-memory platform instead.
 * @import { Database, SqlRunner } from '../types.js';
 */

/**
 * Get the database of a Durable Object instance, for a test to read and write, through Kysely like
 * the core, or with SQL. Every call runs in the instance, against the database it uses itself.
 * @param {DurableObjectStub<any>} stub Instance.
 * @returns {Database & SqlRunner} Database.
 */
export const getObjectDatabase = (stub) => {
  /**
   * Run a database call in the instance.
   * @param {(db: SqlRunner) => Promise<any>} callback Call.
   * @returns {Promise<any>} Result.
   */
  const run = (callback) => runInDurableObject(stub, (instance) => callback(instance.sqlRunner));

  const dialect = createSqliteDialect({
    /**
     * Run a query compiled here with the instance’s own Kysely.
     * @param {import('kysely').CompiledQuery} query Query.
     * @returns {Promise<import('kysely').QueryResult<any>>} Result.
     */
    executeQuery: (query) =>
      runInDurableObject(stub, (instance) => instance.db.executeQuery(query)),
    /**
     * Streaming isn’t needed.
     * @returns {AsyncIterableIterator<any>} Never.
     */
    // eslint-disable-next-line require-yield
    streamQuery: async function* streamQuery() {
      throw new Error('Not supported.');
    },
  });

  return Object.assign(new Kysely({ dialect }), {
    /**
     * Run a query and return all rows.
     * @param {string} sql SQL.
     * @param {any[]} [params] Parameters.
     * @returns {Promise<any[]>} Rows.
     */
    all: (sql, params) => run((db) => db.all(sql, params)),
    /**
     * Run a query and return the first row.
     * @param {string} sql SQL.
     * @param {any[]} [params] Parameters.
     * @returns {Promise<any>} Row, or `null`.
     */
    first: (sql, params) => run((db) => db.first(sql, params)),
    /**
     * Run a statement that changes data.
     * @param {string} sql SQL.
     * @param {any[]} [params] Parameters.
     * @returns {Promise<{ changes: number }>} Result.
     */
    run: (sql, params) => run((db) => db.run(sql, params)),
    /**
     * Run several statements atomically.
     * @param {{ sql: string, params?: any[] }[]} statements Statements.
     * @returns {Promise<void>}
     */
    batch: (statements) => run((db) => db.batch(statements)),
  });
};

/**
 * Get an empty database of its own for a test file, in a Durable Object instance no request goes
 * to.
 * @param {string} name Name, unique to the test file.
 * @returns {Database & SqlRunner} Database.
 */
export const getTestDatabase = (name) =>
  getObjectDatabase(env.DURABLE_OBJECT.get(env.DURABLE_OBJECT.idFromName(`test:${name}`)));

/**
 * Get the Durable Object of the default tenant, the one a single-site deployment has.
 * @returns {DurableObjectStub<any>} Stub.
 */
export const getDefaultTenantObject = () => getTenantObject(env, DEFAULT_TENANT);

/**
 * Database of the default tenant, which the requests of the tests go to.
 */
export const db = getObjectDatabase(getDefaultTenantObject());

/**
 * `ADMIN_SECRET` of the test Worker.
 */
export const { ADMIN_SECRET } = /** @type {{ ADMIN_SECRET: string }} */ (env);

/**
 * Send a request to the Worker.
 * @param {string} path Path.
 * @param {RequestInit} [init] Request options.
 * @returns {Promise<Response>} Response.
 */
export const request = (path, init) =>
  exports.default.fetch(`https://additions.example${path}`, init);

/**
 * Get the Durable Object instance that holds the entry locks: the default tenant’s.
 * @returns {DurableObjectStub<any>} Stub.
 */
export const getLockObject = getDefaultTenantObject;

/**
 * Empty the given tables of a Durable Object instance, leaving out those it hasn’t created yet:
 * an instance creates them on first use.
 * @param {DurableObjectState} state State of the instance.
 * @param {string[]} tables Table names.
 */
const emptyTables = (state, tables) => {
  tables.forEach((table) => {
    const [{ count }] = state.storage.sql
      .exec("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?", table)
      .toArray();

    if (count) {
      state.storage.sql.exec(`DELETE FROM ${table}`);
    }
  });
};

/** @type {WebSocket[]} */
const sockets = [];

/**
 * Open a tab’s connection, and collect the messages sent to every tab.
 * @param {string} token Session token.
 * @param {string} origin Origin of the CMS, which must be allowed.
 * @returns {Promise<any[]>} Messages received, filled in as they come.
 */
export const listen = async (token, origin) => {
  const headers = { Authorization: `Bearer ${token}`, Origin: origin };
  const { ticket } = await (await request('/v1/socket/ticket', { method: 'POST', headers })).json();
  const response = await request(`/v1/socket?ticket=${ticket}`, {
    headers: { Upgrade: 'websocket', Origin: origin },
  });
  const ws = /** @type {WebSocket} */ (response.webSocket);
  /** @type {any[]} */
  const messages = [];

  ws.accept();
  ws.addEventListener('message', ({ data }) => {
    messages.push(JSON.parse(/** @type {string} */ (data)));
  });
  sockets.push(ws);

  return messages;
};

/**
 * Reset what the platform keeps outside the tenant’s tables between tests: the rate limits, the
 * open connections, the alarm and the tenants a test has created.
 * @returns {Promise<void>}
 */
export const resetPlatform = async () => {
  sockets.splice(0).forEach((ws) => ws.close());
  await runInDurableObject(getDefaultTenantObject(), async (_instance, state) => {
    emptyTables(state, ['rate_limit']);
    state.getWebSockets().forEach((ws) => ws.close(1000, 'Test reset'));
    await state.storage.deleteAlarm();
  });

  // The tenants a test has created, and the counters shared by every tenant
  const registry = getRegistryObject(env);

  await Promise.all(
    (await registry.listTenants()).map(async ({ id }) => {
      await getTenantObject(env, id).deleteTenant();
      await registry.removeTenant(id);
    }),
  );
  await runInDurableObject(registry, (_instance, state) => {
    emptyTables(state, ['rate_limit']);
  });
};
