/**
 * The registry of tenants, kept by the Durable Object instance that serves as the registry: one
 * row for each site the Worker serves besides the default one. Each function takes the instance’s
 * SQL storage.
 * @import { SqlStorage } from '../../types.js';
 */

/**
 * A site served by the Worker, besides the default one.
 * @typedef {object} Tenant
 * @property {string} id ID, e.g. `acme`.
 * @property {string} name Name, e.g. `Acme Inc.`.
 * @property {string} created_at Creation date.
 */

/**
 * Create the registry’s table, if needed.
 * @param {SqlStorage} sql Storage.
 */
const ensureTable = (sql) => {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS tenant ' +
      '(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)',
  );
};

/**
 * Count the rows the last statement changed.
 * @param {SqlStorage} sql Storage.
 * @returns {number} Count.
 */
const countChanges = (sql) => Number(sql.exec('SELECT changes() AS changes').one().changes);

/**
 * List the tenants.
 * @param {SqlStorage} sql Storage.
 * @returns {Tenant[]} Tenants, by ID.
 */
export const listTenants = (sql) => {
  ensureTable(sql);

  return /** @type {Tenant[]} */ (
    sql.exec('SELECT id, name, created_at FROM tenant ORDER BY id').toArray()
  );
};

/**
 * Add a tenant.
 * @param {SqlStorage} sql Storage.
 * @param {Tenant} tenant Tenant.
 * @returns {boolean} Whether it was added, rather than already there.
 */
export const addTenant = (sql, { id, name, created_at: createdAt }) => {
  ensureTable(sql);
  sql.exec(
    'INSERT OR IGNORE INTO tenant (id, name, created_at) VALUES (?, ?, ?)',
    id,
    name,
    createdAt,
  );

  return countChanges(sql) > 0;
};

/**
 * Replace a listed tenant’s details, e.g. once a request that completes its creation has created it
 * with its own.
 * @param {SqlStorage} sql Storage.
 * @param {Tenant} tenant Tenant.
 */
export const updateTenant = (sql, { id, name, created_at: createdAt }) => {
  ensureTable(sql);
  sql.exec('UPDATE tenant SET name = ?, created_at = ? WHERE id = ?', name, createdAt, id);
};

/**
 * Remove a tenant.
 * @param {SqlStorage} sql Storage.
 * @param {string} id Tenant ID.
 * @returns {boolean} Whether it was there.
 */
export const removeTenant = (sql, id) => {
  ensureTable(sql);
  sql.exec('DELETE FROM tenant WHERE id = ?', id);

  return countChanges(sql) > 0;
};
