import { DatabaseSync } from 'node:sqlite';

import { Kysely } from 'kysely';

import { createApp } from '../core/app.js';
import { createMemoryPlatform } from '../platforms/memory/index.js';
import { createNodeSqliteDialect, createNodeSqliteRunner } from '../platforms/memory/sqlite.js';

/**
 * What the tests run against on Node: the core on the in-memory platform, whose live updates are
 * recorded. It stands in for `harness.js` in the Node project of the tests.
 * @import { Database, SqlRunner } from '../types.js';
 */

/**
 * `ADMIN_SECRET` of the tests, the same as the Worker’s in `vitest.config.js`.
 */
export const ADMIN_SECRET = 'test-admin-secret-0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Bindings the app gets.
 */
const env = { ADMIN_SECRET };

/**
 * Functions collecting the messages sent to every tab, for {@link listen}.
 * @type {Set<(message: Record<string, any>) => void>}
 */
const listeners = new Set();

/**
 * The platform the tests’ requests go to, with live updates that are recorded rather than sent.
 */
export const memory = createMemoryPlatform({
  realtime: true,
  /**
   * Hand a message sent to every tab to the listeners.
   * @param {Record<string, any>} message Message.
   */
  onBroadcast: (message) => {
    listeners.forEach((listener) => listener(message));
  },
});

const app = createApp(memory.platform, { gitProviders: memory.gitProviders });

/**
 * Wrap a `node:sqlite` database for a test to read and write, through Kysely like the core, or with
 * SQL.
 * @param {DatabaseSync} database Database.
 * @returns {Database & SqlRunner} Database.
 */
const wrapDatabase = (database) =>
  Object.assign(new Kysely({ dialect: createNodeSqliteDialect(database) }), {
    ...createNodeSqliteRunner(database),
  });

/**
 * Database of the tenant, which the requests of the tests go to.
 */
export const db = wrapDatabase(memory.database);

/**
 * Get an empty database of its own for a test file.
 * @param {string} _name Name, unique to the test file.
 * @returns {Database & SqlRunner} Database.
 */
export const getTestDatabase = (_name) => wrapDatabase(new DatabaseSync(':memory:'));

/**
 * Send a request to the app.
 * @param {string} path Path.
 * @param {RequestInit} [init] Request options.
 * @returns {Promise<Response>} Response.
 */
export const request = async (path, init) =>
  app.fetch(new Request(`https://additions.example${path}`, init), env);

/**
 * Run the background jobs, as the platform’s scheduler would.
 * @returns {Promise<number | null>} When the next job is due, if any.
 */
export const runJobs = () => memory.runJobs(env);

/**
 * Get a ticket like a tab opening its connection, and collect the messages sent to every tab.
 * @param {string} token Session token.
 * @param {string} origin Origin of the CMS, which must be allowed.
 * @returns {Promise<any[]>} Messages received, filled in as they come.
 */
export const listen = async (token, origin) => {
  const response = await request('/v1/socket/ticket', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
  });

  if (!response.ok) {
    throw new Error(`No ticket: ${response.status}`);
  }

  /** @type {any[]} */
  const messages = [];

  listeners.add((message) => messages.push(message));

  return messages;
};

/**
 * Reset what the platform keeps outside the tenant’s tables between tests: the rate limits, the
 * wake-ups, the messages and their listeners.
 * @returns {Promise<void>}
 */
export const resetPlatform = async () => {
  listeners.clear();
  memory.reset();
};
