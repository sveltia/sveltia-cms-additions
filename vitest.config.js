import { fileURLToPath } from 'node:url';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

/**
 * Test files that need the Workers runtime itself, e.g. a Durable Object’s WebSockets or alarm,
 * which only run on Cloudflare.
 */
const CLOUDFLARE_ONLY = [
  'lib/platforms/cloudflare/**',
  'lib/core/git-tokens.test.js',
  'lib/core/routes/locks.test.js',
];

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: {
                // Test-only value; a real deployment sets its own secret
                ADMIN_SECRET: 'test-admin-secret-0123456789abcdefghijklmnopqrstuvwxyz',
              },
            },
          }),
        ],
        test: {
          name: 'cloudflare',
          include: ['lib/**/*.test.js'],
          // The in-memory platform runs on Node only
          exclude: ['lib/platforms/memory/**'],
        },
      },
      {
        // The core on the in-memory platform, whose live updates are recorded rather than sent. The
        // endpoints that stand in for them, on a platform that polls, have tests of their own
        resolve: {
          alias: [
            {
              find: /^\.\/harness\.js$/,
              replacement: fileURLToPath(new URL('lib/test/harness.node.js', import.meta.url)),
            },
          ],
        },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'lib/core/**/*.test.js',
            'lib/git/**/*.test.js',
            'lib/platforms/memory/**/*.test.js',
          ],
          exclude: CLOUDFLARE_ONLY,
        },
      },
    ],
  },
});
