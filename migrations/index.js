/**
 * Rebuild a table with a new definition, as SQLite can’t change a column’s type, copying the rows
 * and converting the dates stored as ISO 8601 strings to milliseconds since the epoch.
 * @param {object} args Arguments.
 * @param {string} args.table Table name.
 * @param {string} args.columns Column definitions, as in `CREATE TABLE`.
 * @param {string[]} args.names Column names.
 * @param {string[]} args.dates Names of the date columns to convert.
 * @param {string[]} [args.indexes] `CREATE INDEX` statements to run again.
 * @returns {string[]} Statements.
 */
const rebuildTable = ({ table, columns, names, dates, indexes = [] }) => [
  `CREATE TABLE ${table}_new (${columns})`,
  `INSERT INTO ${table}_new (${names.join(', ')}) SELECT ${names
    .map((name) =>
      dates.includes(name) ? `CAST(ROUND(unixepoch(${name}, 'subsec') * 1000) AS INTEGER)` : name,
    )
    .join(', ')} FROM ${table}`,
  `DROP TABLE ${table}`,
  `ALTER TABLE ${table}_new RENAME TO ${table}`,
  ...indexes,
];

/**
 * SQLite migrations of a tenant’s database, which each tenant’s Durable Object applies to its own
 * storage on its first request after a deploy. Within a major version, migrations only add tables
 * and columns, so the previous release still runs against the newer schema after a rollback. The
 * exceptions are versions 7 and 9, which change the date columns and rename the GitHub accounts,
 * released before 1.0.
 * @import { Migration } from '../lib/types.js';
 * @type {Migration[]}
 */
export const migrations = [
  {
    version: 1,
    name: 'init',
    statements: [
      // Settings managed in the CMS. A secret setting is stored in `ciphertext`, encrypted with the
      // data key, and `value` is `NULL`
      'CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT, ciphertext TEXT, ' +
        'updated_by TEXT, updated_at TEXT NOT NULL)',
      // The data key, wrapped with a key derived from `ADMIN_SECRET`. There is only ever one row
      'CREATE TABLE data_key (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, ' +
        'wrapped TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
      'CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ' +
        'actor_id TEXT, action TEXT NOT NULL, target TEXT, meta TEXT)',
      'CREATE INDEX audit_log_at ON audit_log (at)',
    ],
  },
  {
    version: 2,
    name: 'better-auth',
    // Generated with `node scripts/print-auth-schema.js` for Better Auth 1.7.7
    statements: [
      'create table "user" ("id" text not null primary key, "name" text not null, ' +
        '"email" text not null unique, "emailVerified" integer not null, "image" text, ' +
        '"createdAt" date not null, "updatedAt" date not null, "role" text, "banned" integer, ' +
        '"banReason" text, "banExpires" date, "username" text unique, "displayUsername" text, ' +
        '"mustChangePassword" integer)',
      'create table "session" ("id" text not null primary key, "expiresAt" date not null, ' +
        '"token" text not null unique, "createdAt" date not null, "updatedAt" date not null, ' +
        '"ipAddress" text, "userAgent" text, ' +
        '"userId" text not null references "user" ("id") on delete cascade, "impersonatedBy" text)',
      'create table "account" ("id" text not null primary key, "accountId" text not null, ' +
        '"providerId" text not null, ' +
        '"userId" text not null references "user" ("id") on delete cascade, "accessToken" text, ' +
        '"refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, ' +
        '"refreshTokenExpiresAt" date, "scope" text, "password" text, ' +
        '"createdAt" date not null, "updatedAt" date not null)',
      'create table "verification" ("id" text not null primary key, ' +
        '"identifier" text not null, "value" text not null, "expiresAt" date not null, ' +
        '"createdAt" date not null, "updatedAt" date not null)',
      'create index "session_userId_idx" on "session" ("userId")',
      'create index "account_userId_idx" on "account" ("userId")',
      'create index "verification_identifier_idx" on "verification" ("identifier")',
    ],
  },
  {
    version: 3,
    name: 'github-app',
    statements: [
      // GitHub tokens handed to users, encrypted, so they can be revoked before they expire. Rows
      // are deleted once the token has expired
      'CREATE TABLE issued_token (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, ' +
        'kind TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, ' +
        'token_ciphertext TEXT NOT NULL, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, ' +
        'revoke_requested_at TEXT, revoked_at TEXT)',
      'CREATE INDEX issued_token_user_id ON issued_token (user_id)',
      'CREATE INDEX issued_token_session_id ON issued_token (session_id)',
      // Short-lived records of GitHub App setup runs, which carry the `state` of the manifest and
      // installation flows
      'CREATE TABLE setup_state (state TEXT PRIMARY KEY, stage TEXT NOT NULL, repo TEXT NOT NULL, ' +
        'return_url TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)',
    ],
  },
  {
    version: 4,
    name: 'sign-in-with-github',
    statements: [
      // The GitHub identity a user signs in with, keyed on GitHub’s immutable user ID. An admin can
      // record it before the first sign-in, from the GitHub username. The refresh token of the
      // user-to-server token is kept encrypted, so the CMS gets a new token without signing in again
      'CREATE TABLE github_account (user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ' +
        'ON DELETE CASCADE, github_id TEXT NOT NULL UNIQUE, login TEXT NOT NULL, ' +
        'refresh_token_ciphertext TEXT, refresh_token_expires_at TEXT, created_at TEXT NOT NULL, ' +
        'first_signed_in_at TEXT)',
      // A sign-in through a provider in progress, from the CMS’s request to the provider’s callback
      'CREATE TABLE auth_flow (state TEXT PRIMARY KEY, provider TEXT NOT NULL, ' +
        'redirect_uri TEXT NOT NULL, client_state TEXT NOT NULL, code_challenge TEXT NOT NULL, ' +
        'link_user_id TEXT, expires_at TEXT NOT NULL)',
      // One-time codes the CMS exchanges, with the PKCE verifier, for a session
      'CREATE TABLE auth_code (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, ' +
        'code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL, expires_at TEXT NOT NULL)',
      // Users created by a sign-up rule, who are checked against it again at every sign-in until an
      // admin adopts them
      'CREATE TABLE rule_member (user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ' +
        'ON DELETE CASCADE, rule_id TEXT NOT NULL, created_at TEXT NOT NULL)',
    ],
  },
  {
    version: 5,
    name: 'comments',
    statements: [
      // Comments on entries, private to the CMS’s users. The key names the entry, not a file or a
      // branch, so every locale of an entry and every branch share one conversation. A deleted
      // user’s comments stay, without an author
      'CREATE TABLE comment (id TEXT PRIMARY KEY, entry_key TEXT NOT NULL, ' +
        'user_id TEXT REFERENCES "user" ("id") ON DELETE SET NULL, body TEXT NOT NULL, ' +
        'created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
      'CREATE INDEX comment_entry ON comment (entry_key, created_at)',
    ],
  },
  {
    version: 6,
    name: 'pending-link',
    statements: [
      // The GitHub identity and tokens of a link, encrypted, which only take effect once the code is
      // exchanged with the PKCE verifier, so a link can’t be completed by someone else’s browser
      'ALTER TABLE auth_code ADD COLUMN link_ciphertext TEXT',
    ],
  },
  {
    version: 7,
    name: 'integer-dates',
    // Dates are stored as milliseconds since the epoch rather than ISO 8601 strings, so they compare
    // and sort the same on every database. Better Auth’s tables keep its own format. Unlike the
    // others, this migration changes columns, so the releases before it can’t run against the
    // database once it has been applied
    statements: [
      ...rebuildTable({
        table: 'setting',
        columns:
          'key TEXT PRIMARY KEY, value TEXT, ciphertext TEXT, updated_by TEXT, ' +
          'updated_at INTEGER NOT NULL',
        names: ['key', 'value', 'ciphertext', 'updated_by', 'updated_at'],
        dates: ['updated_at'],
      }),
      ...rebuildTable({
        table: 'data_key',
        columns:
          'id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, ' +
          'wrapped TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL',
        names: ['id', 'version', 'wrapped', 'created_at', 'updated_at'],
        dates: ['created_at', 'updated_at'],
      }),
      ...rebuildTable({
        table: 'audit_log',
        columns:
          'id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id TEXT, ' +
          'action TEXT NOT NULL, target TEXT, meta TEXT',
        names: ['id', 'at', 'actor_id', 'action', 'target', 'meta'],
        dates: ['at'],
        indexes: ['CREATE INDEX audit_log_at ON audit_log (at)'],
      }),
      ...rebuildTable({
        table: 'issued_token',
        columns:
          'id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, ' +
          'role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, token_ciphertext TEXT NOT NULL, ' +
          'issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ' +
          'revoke_requested_at INTEGER, revoked_at INTEGER',
        names: [
          'id',
          'user_id',
          'session_id',
          'kind',
          'role',
          'token_hash',
          'token_ciphertext',
          'issued_at',
          'expires_at',
          'revoke_requested_at',
          'revoked_at',
        ],
        dates: ['issued_at', 'expires_at', 'revoke_requested_at', 'revoked_at'],
        indexes: [
          'CREATE INDEX issued_token_user_id ON issued_token (user_id)',
          'CREATE INDEX issued_token_session_id ON issued_token (session_id)',
        ],
      }),
      ...rebuildTable({
        table: 'setup_state',
        columns:
          'state TEXT PRIMARY KEY, stage TEXT NOT NULL, repo TEXT NOT NULL, ' +
          'return_url TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL',
        names: ['state', 'stage', 'repo', 'return_url', 'created_at', 'expires_at'],
        dates: ['created_at', 'expires_at'],
      }),
      ...rebuildTable({
        table: 'github_account',
        columns:
          'user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE, ' +
          'github_id TEXT NOT NULL UNIQUE, login TEXT NOT NULL, refresh_token_ciphertext TEXT, ' +
          'refresh_token_expires_at INTEGER, created_at INTEGER NOT NULL, ' +
          'first_signed_in_at INTEGER',
        names: [
          'user_id',
          'github_id',
          'login',
          'refresh_token_ciphertext',
          'refresh_token_expires_at',
          'created_at',
          'first_signed_in_at',
        ],
        dates: ['refresh_token_expires_at', 'created_at', 'first_signed_in_at'],
      }),
      ...rebuildTable({
        table: 'auth_flow',
        columns:
          'state TEXT PRIMARY KEY, provider TEXT NOT NULL, redirect_uri TEXT NOT NULL, ' +
          'client_state TEXT NOT NULL, code_challenge TEXT NOT NULL, link_user_id TEXT, ' +
          'expires_at INTEGER NOT NULL',
        names: [
          'state',
          'provider',
          'redirect_uri',
          'client_state',
          'code_challenge',
          'link_user_id',
          'expires_at',
        ],
        dates: ['expires_at'],
      }),
      ...rebuildTable({
        table: 'auth_code',
        columns:
          'code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_challenge TEXT NOT NULL, ' +
          'redirect_uri TEXT NOT NULL, expires_at INTEGER NOT NULL, link_ciphertext TEXT',
        names: [
          'code_hash',
          'user_id',
          'code_challenge',
          'redirect_uri',
          'expires_at',
          'link_ciphertext',
        ],
        dates: ['expires_at'],
      }),
      ...rebuildTable({
        table: 'rule_member',
        columns:
          'user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE, ' +
          'rule_id TEXT NOT NULL, created_at INTEGER NOT NULL',
        names: ['user_id', 'rule_id', 'created_at'],
        dates: ['created_at'],
      }),
      ...rebuildTable({
        table: 'comment',
        columns:
          'id TEXT PRIMARY KEY, entry_key TEXT NOT NULL, ' +
          'user_id TEXT REFERENCES "user" ("id") ON DELETE SET NULL, body TEXT NOT NULL, ' +
          'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL',
        names: ['id', 'entry_key', 'user_id', 'body', 'created_at', 'updated_at'],
        dates: ['created_at', 'updated_at'],
        indexes: ['CREATE INDEX comment_entry ON comment (entry_key, created_at)'],
      }),
    ],
  },
  {
    version: 8,
    name: 'locks-jobs-and-presence',
    statements: [
      // Entry locks and the tickets that open a tab’s connection, which a Durable Object used to
      // create for itself in the same storage, hence `IF NOT EXISTS`
      'CREATE TABLE IF NOT EXISTS lock (key TEXT PRIMARY KEY, user_id TEXT NOT NULL, ' +
        'name TEXT NOT NULL, since INTEGER NOT NULL, connection TEXT NOT NULL, ' +
        'orphaned_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS lock_ticket (ticket TEXT PRIMARY KEY, user_id TEXT NOT NULL, ' +
        'name TEXT NOT NULL, role TEXT NOT NULL, expires_at INTEGER NOT NULL)',
      // Background jobs waiting to run, e.g. a retry of the token revocations
      'CREATE TABLE scheduled_job (name TEXT PRIMARY KEY, due_at INTEGER NOT NULL, ' +
        'attempts INTEGER NOT NULL)',
      // Who has which entries open, where each CMS tab sends a heartbeat instead of keeping a
      // connection open, i.e. without live updates
      'CREATE TABLE presence (connection TEXT PRIMARY KEY, user_id TEXT NOT NULL, ' +
        'name TEXT NOT NULL, open TEXT NOT NULL, seen_at INTEGER NOT NULL)',
    ],
  },
  {
    version: 9,
    name: 'provider-accounts',
    statements: [
      // The identities users sign in with, on any Git provider, keyed on the provider and the
      // user’s immutable ID there. One per provider and user
      'CREATE TABLE provider_account (user_id TEXT NOT NULL REFERENCES "user" ("id") ' +
        'ON DELETE CASCADE, provider TEXT NOT NULL, external_id TEXT NOT NULL, ' +
        'login TEXT NOT NULL, refresh_token_ciphertext TEXT, refresh_token_expires_at INTEGER, ' +
        'created_at INTEGER NOT NULL, first_signed_in_at INTEGER, ' +
        'PRIMARY KEY (user_id, provider), UNIQUE (provider, external_id))',
      'INSERT INTO provider_account (user_id, provider, external_id, login, ' +
        'refresh_token_ciphertext, refresh_token_expires_at, created_at, first_signed_in_at) ' +
        "SELECT user_id, 'github', github_id, login, refresh_token_ciphertext, " +
        'refresh_token_expires_at, created_at, first_signed_in_at FROM github_account',
      'DROP TABLE github_account',
    ],
  },
  {
    version: 10,
    name: 'rule-checks-and-sign-in-index',
    statements: [
      // When a member a sign-up rule let in was last found to still belong to the organization
      'ALTER TABLE rule_member ADD COLUMN checked_at INTEGER',
      // The user list’s last sign-in times, which otherwise scan the whole log
      'CREATE INDEX audit_log_actor ON audit_log (action, actor_id, at)',
    ],
  },
];

/**
 * Latest schema version.
 */
export const LATEST_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
