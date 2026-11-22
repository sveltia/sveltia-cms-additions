/**
 * A parameter bound to an SQL statement.
 * @typedef {string | number | boolean | null | ArrayBuffer} SqlValue
 */

/**
 * An SQL statement with its bound parameters.
 * @typedef {object} SqlStatement
 * @property {string} sql SQL with `?` placeholders.
 * @property {SqlValue[]} [params] Parameters to bind.
 */

/**
 * Result of a statement that changes data.
 * @typedef {object} RunResult
 * @property {number} changes Number of rows changed.
 */

/**
 * Runner of SQL written for SQLite, which only the migrations and the tests use.
 * @typedef {object} SqlRunner
 * @property {<T = Record<string, any>>(sql: string, params?: SqlValue[]) => Promise<T[]>} all Run a
 * query and return all rows.
 * @property {<T = Record<string, any>>(sql: string, params?: SqlValue[]) => Promise<T | null>}
 * first Run a query and return the first row, if any.
 * @property {(sql: string, params?: SqlValue[]) => Promise<RunResult>} run Run a statement that
 * changes data.
 * @property {(statements: SqlStatement[]) => Promise<void>} batch Run several statements atomically.
 */

/**
 * The database the core queries, through Kysely, so the queries work on any database it supports.
 * Each platform supplies one over its own SQL database, e.g. the SQLite storage of a Durable Object.
 * Only the stores in `core/store/` query it.
 * @typedef {import('kysely').Kysely<any>} Database
 */

/**
 * The part of a Durable Object’s SQL storage that the modules keeping their data there use.
 * @typedef {object} SqlStorage
 * @property {(query: string, ...bindings: any[]) => { toArray: () => any[], one: () => any }} exec
 * Run a statement.
 */

/**
 * Result of a rate limit check.
 * @typedef {object} RateLimitResult
 * @property {boolean} allowed Whether the request may proceed.
 * @property {number} retryAfter Seconds until the limit resets. `0` when allowed.
 */

/**
 * The tenant a request is for, which a platform resolves from the request’s environment.
 * @typedef {object} TenantContext
 * @property {Database} db The tenant’s database, migrated to the latest schema.
 * @property {any} authDatabase The same database, in a form Better Auth accepts, e.g. a Kysely
 * dialect.
 */

/**
 * Fixed-window rate limits. A platform serving several tenants counts the admin secret’s attempts
 * (keys starting with `admin_secret:`) across all of them.
 * @typedef {object} RateLimiter
 * @property {(env: any, key: string, options: { limit: number, windowSeconds: number }) =>
 * Promise<RateLimitResult>} consume Count a request against a limit.
 * @property {(env: any, key: string) => Promise<void>} refund Take back a counted request.
 */

/**
 * Runs the background jobs, `runDueJobs` from `core/jobs.js`, when they are due.
 * @typedef {object} Scheduler
 * @property {(env: any, at: number) => Promise<void>} wakeAt Make sure the jobs run by the given
 * time. A platform that runs them on a fixed schedule anyway can do nothing.
 */

/**
 * Live updates to the CMS’s open tabs, over a connection each tab keeps open.
 * @typedef {object} Realtime
 * @property {'websocket' | 'external'} kind How the updates are delivered.
 * @property {(env: any, request: Request) => Promise<Response>} connect Open a tab’s connection,
 * e.g. a WebSocket, with a ticket from `core/locks.js`.
 * @property {(env: any, message: Record<string, any>) => Promise<void>} broadcast Send a message to
 * every open tab, e.g. that an entry’s comments have changed.
 * @property {(env: any, userId: string) => Promise<void>} disconnectUser Close a user’s
 * connections, which their tabs open again with their current session and role, if they still
 * can.
 */

/**
 * Services a platform provides to the core app. Each is an interface a platform implements in its
 * own way, or, for live updates, says it can’t.
 * @typedef {object} Platform
 * @property {string} name Platform name, e.g. `cloudflare`.
 * @property {(request: Request) => string} getBaseURL Get the URL the service is reached at,
 * without a trailing slash: the origin, followed by the tenant’s path if there is one, e.g.
 * `https://cms.example.com/t/acme`. Links the service hands out, such as GitHub’s callback URLs,
 * start with it.
 * @property {(env: any) => Promise<TenantContext>} resolveTenant Get the tenant a request is for.
 * @property {RateLimiter} rateLimits Rate limits.
 * @property {Scheduler} scheduler Background jobs.
 * @property {<T>(env: any, key: string, task: () => Promise<T>) => Promise<T>} runOnce Run a task,
 * sharing its result with the calls for the same key made while it runs, e.g. so concurrent
 * requests refresh a user’s GitHub token once.
 * @property {Realtime | null} realtime Live updates, or `null` where they aren’t possible, and the
 * CMS polls instead.
 */

/**
 * A database migration.
 * @typedef {object} Migration
 * @property {number} version Sequential version number, starting at `1`.
 * @property {string} name Short description.
 * @property {string[]} statements SQL statements to run, in order.
 */

/**
 * Keys derived from the data key.
 * @typedef {object} DataKeys
 * @property {number} version Data key version, incremented on every re-key.
 * @property {CryptoKey} encryptionKey AES-GCM key that encrypts sensitive values in the database.
 * @property {string} signingSecret Secret that signs session tokens, as base64url.
 */

/**
 * State of the data key.
 * @typedef {{ status: 'ok', keys: DataKeys } | { status: 'locked' }} DataKeyState
 */

/**
 * Hono environment of the core app.
 * @typedef {object} AppEnv
 * @property {Record<string, any>} Bindings Platform bindings and variables, including
 * `ADMIN_SECRET`.
 * @property {{ db: Database, authDatabase: any, gitProvider: import('./core/git-provider.js').GitProvider,
 * user: any, session: any }} Variables Per-request variables. `db`, `authDatabase` and
 * `gitProvider` are the tenant’s; `user` and `session` are set by the session middleware.
 */

export {};
