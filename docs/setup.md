# Setting up Sveltia CMS Additions

Sveltia CMS Additions runs on Cloudflare Workers, on the Free plan, and connects a site’s GitHub repository through a GitHub App of its own. Setting it up takes four steps: deploy the Worker, point the CMS at it, run the setup wizard, and go through the checklist at the end. One Worker can also serve [several sites](#several-sites-on-one-worker), e.g. an agency’s clients, each with its own users and data.

## 1. Deploy the Worker

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sveltia/sveltia-cms-additions/tree/main/templates/cloudflare)

The button copies a small repository into your GitHub account, creates the Durable Object that stores the data, and deploys the Worker with Workers Builds. It asks for one value, `ADMIN_SECRET`. Generate it with:

```sh
openssl rand -base64 32
```

Keep it in a password manager. It unlocks the setup wizard, and the data stored in the database is encrypted with a key that it protects.

To deploy from your computer instead, copy `templates/cloudflare/` from this repository, then:

```sh
pnpm install
pnpm exec wrangler secret put ADMIN_SECRET
pnpm run deploy
```

Note the Worker’s URL, e.g. `https://sveltia-cms-additions.example.workers.dev`.

## 2. Point the CMS at it

In the CMS configuration of your site, use the GitHub backend with `auth_type: additions`, and the Worker’s URL as `base_url`:

```yaml
backend:
  name: github
  repo: owner/site
  branch: main
  auth_type: additions
  base_url: https://sveltia-cms-additions.example.workers.dev
```

## 3. Run the setup wizard

Open the CMS and choose **Use Admin Secret** on the sign-in page. The wizard:

1. creates the first admin account, and adds the site’s domain to the allowed domains;
2. registers a GitHub App for the site, and asks you to install it. Install it on **Only select repositories**, with just the site’s repository.

It shows one step at a time. Opened again once both are done, it sums up the setup, and **Reset Admin Password** sets a new password for an admin who can’t sign in.

Then sign in with the admin account. **Administration**, next to the other pages in the toolbar, lets you add people under **Users**, choose who can sign in with GitHub under **Sign-In**, edit the allowed domains under **Domains**, check the GitHub App under **GitHub**, and share API keys and the deploy hook with everyone under **Credentials**.

Keys entered under **Credentials**, e.g. for a translation service or cloud storage, are used by everyone who signs in, unless they enter their own in Settings. The CMS calls these services from the browser, so anyone who can sign in can read the keys: only share keys you’re happy for the whole team to have.

If you forget the admin password, the wizard can reset it with the admin secret. If you lose the admin secret, set a new one in the Cloudflare dashboard, open the wizard with it, and choose **Start Over**: passwords are kept, but everyone is signed out and the GitHub App’s private key has to be uploaded again.

## 4. Check your setup

1. Turn on two-factor authentication for the Cloudflare and GitHub accounts. Give Cloudflare members the smallest role that works, and scope API tokens.
2. Keep `ADMIN_SECRET` in a password manager, and nowhere else.
3. Make sure the GitHub App is installed on the site’s repository only.
4. Add a ruleset to the repository that blocks force pushes and restricts deletions on the default branch and on tags, without the app on its bypass list. The **GitHub** section of Administration warns you until there is one.
5. Move deployment secrets to environment secrets limited to protected branches, so a change pushed through the CMS can’t reach them.
6. Check the allowed domains. Besides letting a site use the service, they decide where sign-in codes may be sent, so list only sites you control. Prefer exact hostnames; a wildcard is only accepted as a leading `*.`, e.g. `*.example.com`, and never on a domain others can get subdomains of, e.g. `*.pages.dev` or `*.netlify.app`. Entries saved by an earlier version with a wildcard elsewhere, e.g. `example.*`, no longer match anything.
7. Pin the version of Sveltia CMS your site loads, and add a Content Security Policy to the CMS page.
8. Watch this repository’s releases, and update when the Administration page says a new one is out.

A few things work as designed, but are worth knowing:

- Someone who signs in with GitHub gets a token of their own, with the access GitHub gives them, whatever their role in the CMS. A viewer who can write to the repository on GitHub can write through the CMS.
- Every signed-in user gets the shared credentials, viewers included.
- Wrong admin secrets are rate-limited for every client together, so someone who keeps sending them can keep the setup wizard locked for a while, the right secret included. The limit stops guessing spread over many addresses.

## Several sites on one Worker

A single Worker can serve several sites, each a _tenant_ with its own users, sessions, settings, GitHub App and data, kept in a storage of its own that no other tenant can reach. The site set up above is the _default_ tenant, served at the root of the Worker. Any other tenant is served under `/t/<ID>`.

Manage the tenants in the setup wizard of the default site’s CMS: choose _Use admin secret_ on its sign-in page, enter the admin secret, and choose **Manage Other Sites** to add a site, copy its URL or delete it. Each tenant’s admins then manage its users on the Administration page of that site’s CMS.

You can also create a tenant with the admin secret from the command line:

```sh
curl -X POST https://sveltia-cms-additions.example.workers.dev/v1/tenants \
  -H "Authorization: Bearer $ADMIN_SECRET" -H 'Content-Type: application/json' \
  -d '{ "id": "acme", "name": "Acme Inc." }'
```

The ID is 1 to 32 lower-case letters, digits and hyphens. The response gives the tenant’s `url`, which is the `base_url` of its CMS configuration:

```yaml
backend:
  name: github
  repo: acme/website
  auth_type: additions
  base_url: https://sveltia-cms-additions.example.workers.dev/t/acme
```

Then run the setup wizard in that site’s CMS, as in step 3: it creates the site’s first admin and its own GitHub App. `GET /v1/tenants` lists the tenants, and `DELETE /v1/tenants/<ID>` deletes one with all its data, which can’t be undone.

The tenants share the admin secret, which unlocks each one’s setup wizard, and the Free plan’s allowances. If you change `ADMIN_SECRET`, open the setup wizard of every tenant with the new secret to re-wrap its data key, as in step 3.

To keep clients apart at the Cloudflare account level as well, deploy a separate Worker for each instead, giving each its own Worker name: the Deploy button asks for it, and from your computer, change `name` in `wrangler.jsonc` before the first deploy.

## Renaming or moving the repository

Renaming the repository doesn’t break anything: the service knows it by its ID, and picks up the new name, which **GitHub** in Administration then shows. Change `repo` in the CMS configuration to the new name as well; GitHub redirects the old one only until another repository takes it.

Moving the repository to another owner takes it out of the GitHub App’s installation. Install the app for the new owner, with the repository selected, then run the setup wizard again to record the installation.

## Updating

Dependabot opens a pull request in your copy of the repository when a new version is released. Merge it, and Workers Builds deploys the update. You can also change the version of `@sveltia/cms-additions` in its `package.json`. Don’t change `wrangler.jsonc` unless the release notes ask you to.

Each site’s database is migrated to the new version on its first request after the update; there is nothing to run. Within a major version, an update only adds to the database, so going back to the previous release keeps working.
