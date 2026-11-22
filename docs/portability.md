# Portability: other platforms and Git providers

Sveltia CMS Additions runs on Cloudflare Workers today, with GitHub as its only Git provider. This document describes how to change the codebase so it can also run on platforms like Netlify and Vercel, and work with GitLab, Gitea and Forgejo, without forking the core. It started as a plan: section 2 describes where things stood then, and the rest how to get from there. Phases 1, 2 and 5 have landed since; section 5 says what’s left of them.

## 1. Goals

- **One core, several platforms.** The routes, the sign-in flows, user management, locks, comments and settings are written once. A platform supplies a small set of capabilities: a database, rate limits, scheduled jobs, live updates and tenancy.
- **One core, several Git providers.** The core asks for what it needs, e.g. “a token for this user with this role”, and a provider adapter works out how its Git host does that.
- **Graceful degradation.** A platform that can’t offer a capability, e.g. WebSockets on a serverless function, still works, with less, e.g. the CMS falls back to polling.
- **No behaviour change on Cloudflare.** Each step lands with the Cloudflare build behaving as before, and the existing tests passing.

Out of scope: running several Git providers for one site at once, and moving data between platforms.

## 2. Where things stood

The code is split into `lib/core` (the app, platform-agnostic in intent), `lib/git/github` (GitHub only) and `lib/platforms/cloudflare` (the Worker, the Durable Object and the operator API). `lib/types.js` defines the `Platform` the core gets, and the `Database` interface (`all`, `first`, `run`, `batch`) it queries through.

What’s already portable:

- The HTTP layer is Hono, which runs on Netlify, Vercel, Deno, Bun and Node.
- Better Auth takes any Kysely dialect; `lib/platforms/cloudflare/kysely-dialect.js` adapts the Durable Object’s SQLite to one.
- Encryption uses Web Crypto, and secrets come from the environment.

What isn’t:

- **SQL written for SQLite.** About 70 queries in 13 core modules are hand-written strings, e.g. in `lib/core/auth/flows.js`. Most are plain SQL, but they use `?` placeholders (Postgres uses `$1`), `INSERT OR IGNORE` / `INSERT OR REPLACE` (`settings.js`, `crypto/data-key.js`, `locks.js`), `changes()`, `AUTOINCREMENT` in the migrations, dates stored as ISO strings and compared as text, and booleans as `0`/`1`. That works on any SQLite, e.g. D1 or Turso, but not on Postgres or MySQL.
- **Reliance on the Durable Object running one request at a time.** Several operations read, then write, in two statements, and are only correct because nothing else runs in between. See section 3.2.
- **Synchronous storage.** The locks and their tickets (`lib/core/locks.js`) and the rate limits use the Durable Object’s synchronous `SqlStorage`, not the `Database` interface.
- **WebSockets and alarms.** Live updates (locks, presence, comment and credential notices) use hibernating WebSockets, and the background jobs (releasing orphaned locks, retrying token revocations) use the Durable Object’s alarm.
- **Tenancy.** Each site is a Durable Object with its own SQLite database, found through a registry object.
- **GitHub everywhere.** Nine core modules import `lib/git/github` directly. The `github_account` table, the `github_*` settings and several error codes the CMS knows are named after it.

## 3. Design

### 3.1 Data access

All SQL moves to [Kysely](https://kysely.dev/), already a dependency through Better Auth. A platform supplies a Kysely dialect instead of a `Database`:

| Database                        | Dialect                                                 |
| ------------------------------- | ------------------------------------------------------- |
| Durable Object SQLite           | the existing `kysely-dialect.js`                        |
| Cloudflare D1                   | `kysely-d1`                                             |
| Turso / libSQL                  | `@libsql/kysely-libsql`                                 |
| Postgres, e.g. Neon or Supabase | `kysely` `PostgresDialect`, or Neon’s serverless driver |
| MySQL                           | `kysely` `MysqlDialect`                                 |

Kysely writes the placeholders, upserts (`onConflict`), `RETURNING` and schema changes for each database, so the queries are written once.

The queries move out of the routes and services into one module per table, under `lib/core/store/`: `flows.js`, `codes.js`, `tokens.js`, `users.js`, `accounts.js`, `comments.js`, `locks.js`, `settings.js`, `audit.js`, `tenants.js`. Each exports functions with names from the domain, e.g. `takeFlow(db, state)` or `markTokensForRevocation(db, target)`, and nothing outside `store/` writes SQL. That keeps the dialect concerns in one place, and lets a store be tested on its own against each database.

Types are normalized so the same data reads the same everywhere:

- **Dates** are stored as integers (milliseconds since the epoch) rather than ISO strings, so comparisons and `ORDER BY` work the same on every database. A migration converts the existing text columns.
- **Booleans** are read through a helper that accepts `0`/`1` and `true`/`false`, and written as the dialect expects.
- **IDs** stay text, generated by the app, so no database needs sequences; the `audit_log` `AUTOINCREMENT` key becomes a generated ID.

Migrations become Kysely migrations using the schema builder, in the same order and with the same version numbers. The rule that a major version only adds tables and columns stays, so a rollback keeps working.

### 3.2 Operations that must not be split

On a Durable Object, one tenant’s requests never interleave between storage calls, so reading a row and then deleting it is effectively one step. On serverless functions sharing a database, two requests can run those steps at the same time. Each of these becomes a single statement, or a transaction, that’s correct on its own:

| Operation | Today | Becomes |
| --- | --- | --- |
| Taking a sign-in flow (`takeFlow`) | `SELECT`, then `DELETE` | `DELETE … WHERE state = ? RETURNING *`, then the provider and expiry checks, so a state can’t be tried twice |
| Redeeming a one-time code (`redeemCode`) | `SELECT`, then `DELETE` | `DELETE … RETURNING *`, then the PKCE check |
| Redeeming a socket ticket (`redeemTicket`) | `SELECT`, then `DELETE` | `DELETE … RETURNING *` |
| Advancing a setup run (`getSetupState`, then the callback) | `SELECT`, then `UPDATE` | `UPDATE … WHERE state = ? AND stage = ? RETURNING *` |
| Keeping one admin (`assertNotLastAdmin`) | count, then change | the change with a condition: `UPDATE "user" … WHERE id = ? AND (role <> 'admin' OR (SELECT COUNT(*) …) > 1)`, checking the rows changed; a deletion likewise |
| Acquiring or taking over a lock | `SELECT`, then `INSERT OR REPLACE` | an upsert that only applies if the lock is free, orphaned for the same user, or held by the same connection, returning the row |
| Renaming comments (`renameComments`) | count, then `UPDATE` | `UPDATE … WHERE entry_key = ? AND NOT EXISTS (comments on the new key)`, counting the rows changed |
| Adding a comment (`createComment`) | count, then `INSERT` | `INSERT … SELECT … WHERE (SELECT COUNT(*) …) < ?` |
| Counting a rate limit | `SELECT`, then `INSERT` or `UPDATE` | an upsert that increments and returns the count |
| Creating the data key (`getDataKeys`) | `INSERT OR IGNORE`, then `SELECT` | an `onConflict` upsert, then `SELECT`: already safe, as the insert can’t be split |

MySQL has no `RETURNING`; on it, the stores use a transaction with `SELECT … FOR UPDATE`. That’s a reason to support MySQL last, if at all.

These changes are worth making on Cloudflare too: they make the code correct without depending on how the runtime schedules requests.

### 3.3 Platform capabilities

`Platform` becomes a set of smaller interfaces. A platform provides each one, or says it can’t:

```js
/**
 * @typedef {object} Platform
 * @property {string} name E.g. `cloudflare`, `netlify`, `vercel`, `node`.
 * @property {(request: Request) => string} getBaseURL URL the service is reached at.
 * @property {(env: any) => Promise<TenantContext>} resolveTenant See section 3.4.
 * @property {RateLimiter} rateLimits
 * @property {Scheduler} scheduler
 * @property {(env: any, key: string, task: () => Promise<any>) => Promise<any>} runOnce Share a
 * task with concurrent calls, e.g. a GitHub token refresh.
 * @property {Realtime | null} realtime `null` where live updates aren’t possible.
 */

/**
 * @typedef {object} TenantContext
 * @property {import('kysely').Kysely<any>} db The tenant’s database.
 * @property {any} authDatabase The same database, as Better Auth takes it.
 */
```

**Rate limits.** `consume(key, limit, windowSeconds)` and `refund(key)`. On Cloudflare, the Durable Object counters (`rate-limits.js`). Elsewhere, a `rate_limit` table with an atomic upsert (section 3.2), or Upstash Redis where one is configured. Limits shared by every tenant, e.g. the admin secret attempts, use a key prefix the implementation routes to a shared store.

**Scheduled jobs.** The core exposes one function, `runDueJobs(context)`, which releases orphaned locks, expires tickets and codes, and retries token revocations. `Scheduler.wakeAt(time)` asks for it to run by a given time. On Cloudflare, that’s the Durable Object alarm, as now. On Netlify and Vercel, scheduled functions or cron call an internal endpoint every minute, which runs `runDueJobs` for each tenant with something due; `wakeAt` is then a no-op, as the cron job runs anyway. The jobs are idempotent, so running them more often than needed is harmless.

**Live updates.** The `Realtime` interface carries what the WebSocket does today:

```js
/**
 * @typedef {object} Realtime
 * @property {'websocket' | 'external'} kind
 * @property {(env: any, request: Request) => Promise<Response>} connect With a ticket from the core.
 * @property {(env: any, message: object) => Promise<void>} broadcast To every connection of the
 * tenant.
 * @property {(env: any, userId: string) => Promise<void>} disconnectUser
 */
```

On Cloudflare, the Durable Object’s hibernating WebSockets. Serverless functions can’t hold a WebSocket open, so the options there are:

1. **No live updates** (`realtime: null`). Locks still work, as they live in the database. Each CMS tab sends a heartbeat, `POST /v1/presence` with its tab ID and open entries, every 15 seconds, which answers with every lock and who has which entry open, and changes locks with `POST /v1/locks`; `DELETE /v1/presence/:connection` closes a tab. A tab that stops sending heartbeats counts as closed after 45 seconds, and the scheduled jobs give its locks the usual grace period. The comment counts are polled with `GET /v1/comments/counts`.
2. **An external service**, e.g. Ably, Pusher or PartyKit: Sveltia CMS Additions publishes to a channel per tenant, and the CMS subscribes with a token Sveltia CMS Additions mints for it. The adapter implements `broadcast` and `disconnectUser` with that service’s API.

The lock and presence logic moves out of `core/locks.js`’s synchronous storage into `store/locks.js` and `store/presence.js` on the database, so the same rules apply whichever way updates are delivered. The Cloudflare implementation can keep presence in the WebSocket attachments, as now.

`GET /version` reports which capabilities the deployment has, e.g. `"realtime": "websocket" | "external" | "none"`, and the CMS chooses the socket, the external client or polling from that. The CMS already handles the socket being down, which is the starting point for polling.

**Request context.** Hono’s `c.env` stays the way the environment reaches the core. Per-request work that has to finish after the response, e.g. scheduling a revocation retry, goes through `c.executionCtx.waitUntil` where the platform has it, and is awaited otherwise.

### 3.4 Tenancy

A tenant becomes “an ID and a database”, which the platform resolves from the request (`resolveTenant`). Two layouts:

- **A database per tenant**, as on Cloudflare (a Durable Object each) or with Turso, which can create a database per tenant. The registry lists them.
- **One shared database** with a `tenant_id` column on every table, e.g. a single Postgres on Netlify or Vercel. The stores add the condition to every query, through a Kysely plugin, so no query can forget it. Unique constraints gain the tenant ID, e.g. `(tenant_id, username)`.

The operator API and the setup wizard don’t change: they create, list and delete tenants through the platform’s registry. The default tenant, served at the root, stays the one a single-site deployment uses.

### 3.5 Git providers

`lib/git/` gets an interface the core uses, with an adapter per provider: `lib/git/github/` as now, then `lib/git/gitlab/` and `lib/git/gitea/` (which also covers Forgejo, whose API is the same). The site’s provider is a setting, chosen in the setup wizard; a site uses one provider.

The interface is pitched at what the core needs, not at how GitHub does it:

```js
/**
 * @typedef {object} GitProvider
 * @property {string} id E.g. `github`, `gitlab`, `gitea`.
 * @property {ProviderCapabilities} capabilities
 * @property {SetupFlow} setup Connect the service to the provider and a repository.
 * @property {(context) => Promise<ProviderStatus>} getStatus For the Administration page.
 * @property {(context, args: { user, role, session }) => Promise<GitToken>} issueToken A token for
 * the site’s repository with the user’s role.
 * @property {(context, token) => Promise<boolean>} revokeToken
 * @property {OAuthSignIn | null} signIn Sign-in with the provider, if it offers it.
 * @property {(context, args: { group, login }) => Promise<boolean | null>} isGroupMember For sign-up
 * rules; `null` if it couldn’t be checked.
 */
```

How each provider issues tokens differs, which is why the interface stops at `issueToken`:

|  | GitHub | GitLab | Gitea / Forgejo |
| --- | --- | --- | --- |
| Connecting | GitHub App, created from a manifest and installed on the repository | A group or project access token the admin creates, or an OAuth application | An OAuth2 application, plus bot accounts’ tokens |
| Token per role | Installation token minted per request, scoped to the repository and role, lasting an hour | A stored project access token per role (Developer for editors, Reporter for viewers), rotated by the scheduled jobs; they last at least a day | A bot account’s token per role, one with write access and one read-only, or the user’s own OAuth token |
| Users with an account on the provider | User-to-server token, refreshed | OAuth token, refreshed | OAuth token, refreshed |
| Revoking | Each token, or the user’s grant | The OAuth grant; access tokens through the API | The OAuth grant; a bot account’s token is shared, so it’s never revoked for one user |
| Sign-up rules | Organization membership | Group membership | Organization membership |
| Commits authored by the person | Git Data API, or the app with the person as co-author | Commits API with an author | Contents API with an author |

`ProviderCapabilities` tells the core and the CMS what applies, e.g. whether tokens are minted per request or stored and rotated, and whether commits can be signed by the provider. The Administration page shows the provider’s own section, e.g. the GitHub App or the GitLab access tokens, from the same capabilities.

Storage and API names become provider-neutral:

- `github_account` becomes `provider_account (user_id, provider, external_id, login, refresh_token_ciphertext, …)`, keyed on the provider and the user’s ID there. GitHub’s refresh tokens keep the AAD they were encrypted with, which names the old table.
- The `github_*` settings keep their keys: a secret setting’s ciphertext is bound to its key, so renaming them would need the data key, which a migration doesn’t have. Each provider’s settings are its adapter’s, prefixed with its ID, and the site’s provider is the `git_provider` setting, GitHub by default.
- `issued_token.kind` keeps `installation` and `user`, and gains `stored` for a rotated token.
- The routes `/v1/auth/start/github` and the like become `/v1/auth/start/:provider`, whose GitHub paths are the ones the CMS uses already. A provider’s own routes, e.g. the GitHub App’s setup and settings, are registered by its adapter.
- The interface lives in the core (`lib/core/git-provider.js`), and the platform hands the adapters to the app (`createApp(platform, { gitProviders })`), so the core imports nothing from `lib/git/`. The Git token the session returns names its `provider`.
- The error codes the CMS knows stay. Provider-neutral ones are added beside them, e.g. `provider_not_set_up` beside `github_app_not_set_up`, and the CMS learns them before the service starts sending them.

The CMS side follows: Sveltia CMS already has GitLab and Gitea/Forgejo backends, so the Additions code there reads the provider from the session (`git.provider`) and uses that backend with the token it gets.

## 4. Testing

- **Stores** run against every supported database: SQLite through `node:sqlite`, Postgres through [PGlite](https://pglite.dev/), and the Durable Object through the existing Cloudflare test pool. One suite, run once per dialect.
- **The core** runs on Node with an in-memory platform: SQLite, an in-memory rate limiter, a scheduler the tests run by hand, and an in-memory realtime that records what’s broadcast. That makes the core tests faster, and independent of `workerd`.
- **Each platform** has a short conformance suite on top: requests reach the right tenant, scheduled jobs run, live updates arrive (or polling works where there are none).
- **Each provider** has a fake server like `lib/test/fake-github.js`, e.g. `fake-gitlab.js` and `fake-gitea.js`, and a conformance suite over the `GitProvider` interface: tokens per role, revocation, sign-in, group membership, status.

## 5. Plan

Each phase ends with the Cloudflare build behaving as before.

1. **Stores and single-statement operations.** Move the queries to Kysely in `lib/core/store/`, with the changes of section 3.2, and convert dates to integers in a migration. Run the store tests on SQLite and PGlite. _Done when_ no SQL is left outside `store/`, and every test passes on Cloudflare. **Landed**, except the store tests on PGlite and the migrations as Kysely migrations, which wait for phase 4: the stores are tested on the Durable Object’s SQLite and on `node:sqlite`. The rate limits and the list of tenants stay in Cloudflare’s own storage, being Cloudflare’s.
2. **Platform interfaces.** Split `Platform` as in section 3.3, move locks and presence onto the database, add `runDueJobs`, and report the capabilities in `/version`. Add the in-memory platform, and run the core tests on Node. _Done when_ the Cloudflare platform is just one implementation of the interfaces. **Landed.** Sharing a token refresh across serverless instances, which `runOnce` only does within one, waits for phase 4.
3. **Polling in the CMS.** Teach the CMS to poll locks, presence and comment counts when `/version` reports no realtime, and to send the presence heartbeat.
4. **A second platform.** Netlify or Vercel, with Postgres and a shared database, without live updates first, then with an external realtime provider, along with its deployment template and setup docs.
5. **The Git provider interface.** Move GitHub behind it, rename the storage (section 3.5), and keep the GitHub routes and error codes. _Done when_ the core imports nothing from `lib/git/github`. **Landed.** Answering a provider’s own routes only when the site uses it, and the stored tokens GitLab needs, wait for phase 6.
6. **GitLab**, then **Gitea and Forgejo**, each with its fake server, its section on the Administration page, and the CMS reading the provider from the session.

Phases 1 and 2 change no behaviour and can land before a second platform is chosen. Phase 5 can start in parallel with phase 4.

## 6. Open questions

- **Which second platform first?** Netlify and Vercel both offer scheduled functions and Postgres through partners; neither runs WebSockets. The choice mostly decides the realtime provider and the deployment template.
- **Shared or separate databases** for several sites off Cloudflare: a shared Postgres is simpler to run, a database per site keeps the current isolation. Turso supports the latter cheaply.
- **GitLab tokens.** Stored project access tokens rotated by the service, or OAuth only, which needs every CMS user to have a GitLab account? The first keeps “users without a Git account” working, which is the point of the service.
- **Bot accounts on Gitea and Forgejo.** Without tokens scoped per role, editors and viewers need a bot account each. Is asking admins to create two acceptable, or should these providers be OAuth only?
- **Realtime provider.** Which external service to support first, and whether the service mints its tokens or the platform’s integration does.
- **MySQL.** Worth supporting at all, given the lack of `RETURNING`?
