/**
 * Print the SQL that creates Better Auth’s tables for our options, to be copied into a migration
 * in `migrations/index.js`. Run with `node scripts/print-auth-schema.js` after changing the
 * options or upgrading Better Auth, and compare with the existing migrations.
 */
import { DatabaseSync } from 'node:sqlite';

import { getMigrations } from 'better-auth/db/migration';

import { getAuthOptions } from '../lib/core/auth/options.js';

const options = getAuthOptions({
  database: new DatabaseSync(':memory:'),
  secret: 'x'.repeat(32),
  baseURL: 'http://localhost',
});

const { compileMigrations } = await getMigrations(options);

// eslint-disable-next-line no-console
console.log(await compileMigrations());
