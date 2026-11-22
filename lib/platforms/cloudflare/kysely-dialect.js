import { SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler } from 'kysely';

/**
 * @import { CompiledQuery, DatabaseConnection, Dialect, Driver, Kysely, QueryResult } from 'kysely';
 */

/**
 * Statements that may change rows, whose count Kysely reports as the affected rows. One that starts
 * with a CTE (`WITH`) may be a write; for a read, `changes()` is simply not used.
 */
const WRITE_STATEMENT_REGEX = /^\s*(?:insert|update|delete|replace|with)\b/i;

/**
 * Error thrown for what the driver doesn’t support.
 * @param {string} feature Feature.
 * @returns {Promise<never>} Rejection.
 */
const unsupported = async (feature) => {
  throw new Error(`Durable Object storage does not support ${feature}.`);
};

/**
 * Create a connection to the SQLite storage of a Durable Object.
 * @param {SqlStorage} sql Storage.
 * @returns {DatabaseConnection} Connection.
 */
const createConnection = (sql) => ({
  /**
   * Run a query.
   * @param {CompiledQuery} compiledQuery Query.
   * @returns {Promise<QueryResult<any>>} Result.
   */
  executeQuery: async ({ sql: query, parameters }) => {
    const rows = sql.exec(query, ...parameters).toArray();

    if (!WRITE_STATEMENT_REGEX.test(query)) {
      return { rows };
    }

    const { changes, id } = sql
      .exec('SELECT changes() AS changes, last_insert_rowid() AS id')
      .one();

    return { rows, numAffectedRows: BigInt(changes), insertId: BigInt(id) };
  },
  /**
   * Streaming isn’t supported, nor needed by Better Auth.
   * @returns {AsyncIterableIterator<QueryResult<any>>} Never.
   */
  // eslint-disable-next-line require-yield
  streamQuery: async function* streamQuery() {
    await unsupported('streaming queries');
  },
});

/**
 * Create a driver over a single connection. Like Better Auth’s D1 driver, it has no interactive
 * transactions, which Better Auth doesn’t use with SQLite.
 * @param {DatabaseConnection} connection Connection.
 * @returns {Driver} Driver.
 */
const createDriver = (connection) => ({
  /**
   * Nothing to set up.
   * @returns {Promise<void>}
   */
  init: async () => undefined,
  /**
   * Get the connection, which is always the same.
   * @returns {Promise<DatabaseConnection>} Connection.
   */
  acquireConnection: async () => connection,
  /**
   * Interactive transactions aren’t supported.
   * @returns {Promise<never>} Rejection.
   */
  beginTransaction: () => unsupported('interactive transactions'),
  /**
   * Interactive transactions aren’t supported.
   * @returns {Promise<never>} Rejection.
   */
  commitTransaction: () => unsupported('interactive transactions'),
  /**
   * Interactive transactions aren’t supported.
   * @returns {Promise<never>} Rejection.
   */
  rollbackTransaction: () => unsupported('interactive transactions'),
  /**
   * Nothing to release.
   * @returns {Promise<void>}
   */
  releaseConnection: async () => undefined,
  /**
   * Nothing to close.
   * @returns {Promise<void>}
   */
  destroy: async () => undefined,
});

/**
 * Create a SQLite dialect over a single connection.
 * @param {DatabaseConnection} connection Connection.
 * @returns {Dialect} Dialect.
 */
export const createSqliteDialect = (connection) => ({
  /**
   * Create the driver.
   * @returns {Driver} Driver.
   */
  createDriver: () => createDriver(connection),
  /**
   * Create the query compiler, which is SQLite’s.
   * @returns {SqliteQueryCompiler} Compiler.
   */
  createQueryCompiler: () => new SqliteQueryCompiler(),
  /**
   * Create the adapter, which is SQLite’s.
   * @returns {SqliteAdapter} Adapter.
   */
  createAdapter: () => new SqliteAdapter(),
  /**
   * Create the schema introspector, which is SQLite’s. Better Auth only uses it for migrations,
   * which this service runs itself.
   * @param {Kysely<any>} db Database.
   * @returns {SqliteIntrospector} Introspector.
   */
  createIntrospector: (db) => new SqliteIntrospector(db),
});

/**
 * Create a Kysely dialect over the SQLite storage of a Durable Object.
 * @param {SqlStorage} sql Storage.
 * @returns {Dialect} Dialect.
 */
export const createSqlStorageDialect = (sql) => createSqliteDialect(createConnection(sql));
