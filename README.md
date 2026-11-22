# Sveltia CMS Additions

Server-side additions to [Sveltia CMS](https://github.com/sveltia/sveltia-cms) that a single-page app can’t provide on its own: user management with roles, commits for users without a GitHub account, entry locking, showing who has an entry open, comments on entries, and credentials such as API keys shared with every user. It runs as a Cloudflare Worker registered as a GitHub App.

See the [documentation](https://sveltiacms.app/en/docs/additions) for what it does and how to use it with Sveltia CMS.

## Setting up

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sveltia/sveltia-cms-additions/tree/main/templates/cloudflare)

See [`docs/setup.md`](docs/setup.md) for deploying the Worker, connecting the CMS, the setup wizard and a security checklist.

## Development

Use [pnpm](https://pnpm.io/) and the Node.js version in `.nvmrc`.

```sh
pnpm install
cp .dev.vars.example .dev.vars  # then set a throwaway local ADMIN_SECRET
pnpm dev                        # local Worker, with local Durable Object storage
pnpm test                       # tests on Cloudflare’s runtime and on Node
pnpm check                      # ESLint, Prettier, cSpell and audit
```

### Layout

- `lib/core/` is the app, which knows nothing of the platform it runs on or of GitHub. Its routes are in `routes/`, and every SQL query is in `store/`, one module per table, written with [Kysely](https://kysely.dev/) so it runs on any database Kysely supports. `jobs.js` holds the background jobs, and `git-provider.js` the interface Git providers implement.
- `lib/git/github/` is the GitHub adapter: the GitHub App, its tokens, signing in with GitHub, and the routes that set up and manage the app.
- `lib/platforms/cloudflare/` runs the app on Workers: a Durable Object per site, whose SQLite storage is the site’s database, with hibernating WebSockets for live updates and an alarm for the background jobs, and one more that lists the sites.
- `lib/platforms/memory/` keeps everything in one Node process, for the tests. It isn’t part of the package.
- `lib/types.js` defines the `Platform` interfaces a platform implements: the site’s database, rate limits, a scheduler for the jobs, and live updates. A platform without live updates says so, and the tabs then send heartbeats instead; the CMS doesn’t poll yet.
- `migrations/` holds the schema, which each site’s database is migrated to on its first request after a deploy.
- `templates/cloudflare/` is the small wrapper that users deploy; it depends on the published `@sveltia/cms-additions` package.

[`docs/portability.md`](docs/portability.md) explains the design, and the plan for other platforms and Git providers.

### Tests

`pnpm test` runs two [Vitest](https://vitest.dev/) projects:

- `cloudflare` runs the tests in the Workers runtime, against the Worker and its Durable Objects: all of them except the in-memory platform’s.
- `node` runs the core’s tests, and the GitHub adapter’s, on the in-memory platform, along with the tests of the endpoints that stand in for live updates where a platform has none. The tests that need a Durable Object’s WebSockets or alarm only run on Cloudflare.

The tests reach the app through `lib/test/helpers.js`, which takes what depends on the platform from `lib/test/harness.js`; the `node` project swaps that for `harness.node.js`. A fake GitHub (`lib/test/fake-github.js`) answers GitHub’s API. To run one project, add its name, e.g. `pnpm test --project node`.

## License

MIT
