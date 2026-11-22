/**
 * @import { SqlRunner, SqlValue } from '../../types.js';
 */

/**
 * Run SQL written for SQLite on the storage of a Durable Object, for the migrations and the tests.
 * The storage API is synchronous; the runner is asynchronous, like the migrations expect.
 * @param {DurableObjectStorage} storage Storage of the Durable Object.
 * @returns {SqlRunner} Runner.
 */
export const createSqlRunner = (storage) => {
  const { sql } = storage;

  /**
   * Run a statement and return its cursor.
   * @param {string} query SQL.
   * @param {SqlValue[]} [params] Parameters.
   * @returns {SqlStorageCursor<Record<string, SqlStorageValue>>} Cursor.
   */
  const exec = (query, params = []) => sql.exec(query, ...params);

  return {
    /**
     * Run a query and return all rows.
     * @param {string} query SQL.
     * @param {SqlValue[]} [params] Parameters.
     * @returns {Promise<any[]>} Rows.
     */
    all: async (query, params) => exec(query, params).toArray(),
    /**
     * Run a query and return the first row.
     * @param {string} query SQL.
     * @param {SqlValue[]} [params] Parameters.
     * @returns {Promise<any>} Row, or `null`.
     */
    first: async (query, params) => exec(query, params).toArray()[0] ?? null,
    /**
     * Run a statement that changes data.
     * @param {string} query SQL.
     * @param {SqlValue[]} [params] Parameters.
     * @returns {Promise<{ changes: number }>} Result.
     */
    run: async (query, params) => {
      // Read the cursor to the end, so the statement has run in full. SQLite counts the rows it
      // changed, which unlike the rows written leaves out index updates
      exec(query, params).toArray();

      return { changes: Number(exec('SELECT changes() AS changes').one().changes) };
    },
    /**
     * Run several statements atomically.
     * @param {{ sql: string, params?: SqlValue[] }[]} statements Statements.
     * @returns {Promise<void>}
     */
    batch: async (statements) => {
      storage.transactionSync(() => {
        statements.forEach(({ sql: query, params }) => exec(query, params).toArray());
      });
    },
  };
};
