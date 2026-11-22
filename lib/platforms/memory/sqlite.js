import { SqliteDialect } from 'kysely';

/**
 * Node’s built-in SQLite (`node:sqlite`), as Kysely and the migrations take it.
 * @import { DatabaseSync } from 'node:sqlite';
 * @import { Dialect } from 'kysely';
 * @import { SqlRunner, SqlValue } from '../../types.js';
 */

/**
 * Create a Kysely dialect over a `node:sqlite` database, which Kysely’s SQLite dialect takes once
 * it looks like `better-sqlite3`.
 * @param {DatabaseSync} database Database.
 * @returns {Dialect} Dialect.
 */
export const createNodeSqliteDialect = (database) =>
  new SqliteDialect({
    database: {
      /**
       * Prepare a statement.
       * @param {string} sql SQL.
       * @returns {any} Statement.
       */
      prepare: (sql) => {
        const statement = database.prepare(sql);

        return {
          reader: statement.columns().length > 0,
          /**
           * Run a query and return all rows.
           * @param {SqlValue[]} params Parameters.
           * @returns {unknown[]} Rows.
           */
          all: (params) => statement.all(.../** @type {any[]} */ (params)),
          /**
           * Run a statement.
           * @param {SqlValue[]} params Parameters.
           * @returns {{ changes: number | bigint, lastInsertRowid: number | bigint }} Result.
           */
          run: (params) => statement.run(.../** @type {any[]} */ (params)),
          /**
           * Run a query and iterate over its rows.
           * @param {SqlValue[]} params Parameters.
           * @returns {IterableIterator<unknown>} Rows.
           */
          iterate: (params) => statement.iterate(.../** @type {any[]} */ (params)),
        };
      },
      /**
       * Close the database.
       * @returns {void}
       */
      close: () => database.close(),
    },
  });

/**
 * Run SQL written for SQLite on a `node:sqlite` database, for the migrations and the tests.
 * @param {DatabaseSync} database Database.
 * @returns {SqlRunner} Runner.
 */
export const createNodeSqliteRunner = (database) => {
  /**
   * Prepare a statement and bind its parameters.
   * @param {string} sql SQL.
   * @param {SqlValue[]} [params] Parameters.
   * @returns {{ all: () => any[], run: () => { changes: number | bigint } }} Statement.
   */
  const bind = (sql, params = []) => {
    const statement = database.prepare(sql);

    return {
      /**
       * Run it and return all rows.
       * @returns {any[]} Rows.
       */
      all: () => statement.all(.../** @type {any[]} */ (params)),
      /**
       * Run it.
       * @returns {{ changes: number | bigint }} Result.
       */
      run: () => statement.run(.../** @type {any[]} */ (params)),
    };
  };

  return {
    /**
     * Run a query and return all rows.
     * @param {string} sql SQL.
     * @param {SqlValue[]} [params] Parameters.
     * @returns {Promise<any[]>} Rows.
     */
    all: async (sql, params) => bind(sql, params).all(),
    /**
     * Run a query and return the first row.
     * @param {string} sql SQL.
     * @param {SqlValue[]} [params] Parameters.
     * @returns {Promise<any>} Row, or `null`.
     */
    first: async (sql, params) => bind(sql, params).all()[0] ?? null,
    /**
     * Run a statement that changes data.
     * @param {string} sql SQL.
     * @param {SqlValue[]} [params] Parameters.
     * @returns {Promise<{ changes: number }>} Result.
     */
    run: async (sql, params) => ({ changes: Number(bind(sql, params).run().changes) }),
    /**
     * Run several statements atomically.
     * @param {{ sql: string, params?: SqlValue[] }[]} statements Statements.
     * @returns {Promise<void>}
     */
    batch: async (statements) => {
      database.exec('BEGIN');

      try {
        statements.forEach(({ sql, params }) => bind(sql, params).run());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
};
