# Manual testing

The unit and end-to-end tests run against mocks of GitHub, the service and the socket. This checklist covers what they can’t: the real GitHub App and its tokens, the Durable Objects’ storage and hibernation, sign-in redirects and popups, and two people working at once.

Work through it top to bottom: later sections rely on the accounts and settings made earlier. Note anything unexpected next to the item, with the time, so it can be found in `wrangler tail`.

## Before you start

- A Cloudflare account on the Free plan, so the CPU limits are the real ones.
- A test GitHub repository with some entries and images, under an account or organization you can install apps on. Not a real site.
- Sveltia CMS v0.271.0 or later, which supports Sveltia CMS Additions: a release loaded by the test site, or a build of the `main` branch, served from the site with `pnpm dev` (`VITE_SITE_URL` pointing at it) or copied into it.
- Two browsers, or two profiles of one, so two people can be signed in at once. Call them **A** and **B**. Keep a private window at hand for a third.
- A second GitHub account, for the person who signs in with GitHub.
- `pnpm exec wrangler tail` running in a terminal, to see errors and CPU time.

Deploy the Worker from `templates/cloudflare/` as the setup guide says, with a fresh `ADMIN_SECRET`, and point the test site’s CMS configuration at it:

```yaml
backend:
  name: github
  repo: owner/test-site
  branch: main
  auth_type: additions
  base_url: https://<worker>.workers.dev
```

## 1. Setup wizard

- [ ] `GET /` on the Worker shows the product name and version, and says to finish setup in the CMS.
- [ ] `GET /version` reports `setup.admin_secret: "ok"`, no admin and no GitHub App.
- [ ] The sign-in page offers **Use Admin Secret**. A wrong secret is refused with a clear message; repeated wrong secrets are eventually rate-limited.
- [ ] With the right secret, the wizard shows “Step 1 of 2” and creates the first admin; only then does the GitHub step appear. The site’s domain is added to the allowed domains.
- [ ] The wizard registers the GitHub App: GitHub shows the manifest with the expected name and permissions, then asks to install it. Install it on **Only select repositories**, with the test repository only.
- [ ] Back in the CMS, the sign-in page says setup succeeded.
- [ ] Installing on a different repository, or on all repositories of another account, is reported as an error, and the CMS doesn’t accept it.
- [ ] Opening the wizard again with the admin secret says setup is complete, with no form. **Reset Admin Password** with an existing admin’s username resets their password, which works for signing in.
- [ ] **Start Over** (after changing `ADMIN_SECRET` in the Cloudflare dashboard and losing the old one): everyone is signed out, passwords still work, and the **GitHub** section of Administration asks for the private key again. Upload it from the GitHub App’s settings, and commits work again.
- [ ] Changing `ADMIN_SECRET` while still knowing the previous one keeps everything working without Start Over.

## 2. Signing in with a password

- [ ] The admin signs in. The toolbar shows **Administration** after the other pages, which opens on **Users**, and Settings has an **Account** tab.
- [ ] A wrong password is refused, and the error doesn’t say whether the username exists.
- [ ] Ten wrong passwords for one username are rate-limited, and the right password works again once the limit has passed.
- [ ] Reloading the page signs in again on its own, without the form.
- [ ] **Sign Out** ends the session: reloading shows the sign-in page, and the GitHub token the CMS had is revoked (check with `curl -H "Authorization: Bearer <token>" https://api.github.com/installation/repositories`, taking the token from the browser’s storage before signing out).
- [ ] Settings opens on the **Account** tab. Changing the name is saved and used as the commit author. The username and the email are shown, but can’t be changed there; `PATCH /v1/auth/profile` with an `email` is refused with 403.
- [ ] Settings › **Account** › **Change Password**: a wrong current password is refused; a new password works, the old one doesn’t, and other tabs and browsers signed in as the same person are signed out.
- [ ] After an hour, when the installation token expires, the CMS fetches a new one on its own: saving still works, with no sign-in prompt. `wrangler tail` shows a call to `/v1/auth/token`.

## 3. Administration

As the admin, in browser **A**:

- [ ] **Administration** in the toolbar opens on **Users**, at `#/admin/users`. Each section in the sidebar has its own URL, and reloading stays on it.
- [ ] On a phone-sized window, the bottom navigation has no Administration button; the Menu page lists the sections instead, and each section has a back button to the list.
- [ ] With developer mode on in Settings, **CMS Configuration** is the last section, and an old `#/config` link leads to it.
- [ ] Add an editor and a viewer. Each temporary password is shown once, and can be copied.
- [ ] In browser **B**, the editor signs in with the temporary password and has to choose a new one before anything else.
- [ ] Changing the editor’s role to viewer revokes their GitHub token, so it takes effect at browser **B**’s next request to GitHub, without signing in again: **B** becomes read-only. An entry **B** has open loses its lock, as **B**’s connection is closed and opened again with the new role.
- [ ] **Reset Password** gives a new temporary password; the old password stops working.
- [ ] **Sign Out Everywhere** signs the user out in browser **B** at its next request, and closes **B**’s connection at once: others see **B**’s locks go 30 seconds later.
- [ ] **Disable** stops the user from signing in, and signs them out, closing their connection the same way; **Enable** lets them back in.
- [ ] **Delete User** removes them; their comments stay, as by “Deleted user”.
- [ ] The editor sees no **Administration** button, and `#/admin/users` says the page can’t be found.
- [ ] The admin can’t reset their own password, sign themselves out everywhere, disable or delete themselves from the menu, and the last admin can’t lose the role.
- [ ] **Domains** section: removing the site’s domain makes the CMS fail to reach the service from it, with a clear error; adding it back fixes it. A wildcard such as `*.example.com` works for a subdomain, not for the bare domain.
- [ ] **GitHub** section: shows the app and its installation, and warns until the repository has a ruleset blocking force pushes and deletions on the default branch without the app on the bypass list. Add one, and the warning goes.
- [ ] **GitHub** section: uploading the wrong private key is refused; the right one is accepted.
- [ ] Rename the test repository on GitHub. Without changing anything else, saving an entry still works, and the **GitHub** section shows the new name after **Check Again**. Then change `repo` in the CMS configuration to match.

## 4. Commit author

Set in the **GitHub** section of Administration, then saved as the editor in browser **B**:

- [ ] **The person**: on GitHub, the commit’s author is the editor’s name and their `users.noreply` address, and the committer is the app. Note whether GitHub shows **Verified**.
- [ ] **The app**: the commit’s author is the app, with a `Co-authored-by` trailer naming the editor. GitHub shows both avatars.
- [ ] Changing the setting reaches a tab that’s already open, at its next token refresh, without signing in again.
- [ ] As the person, save an entry with images totalling more than 16 MB: it goes in one commit, and the images and the entry all land.
- [ ] As the app, the same save is split into several commits, with the Save button showing the progress, and the entry in the last commit.
- [ ] As the person, a save after someone else has pushed to the branch says the branch has moved, and nothing is half-saved.

## 5. Viewers

As the viewer:

- [ ] Every collection and entry opens, but there is no Save, Delete, upload or reorder anywhere, and fields are read-only.
- [ ] The asset library can be browsed, but nothing can be uploaded, renamed or deleted.
- [ ] Editorial Workflow, if turned on, can be viewed but not changed.
- [ ] A write sent by hand with the viewer’s GitHub token is refused by GitHub (the token is read-only), not just hidden in the UI.
- [ ] The viewer can still comment (section 8).

## 6. Signing in with GitHub

- [ ] Turn on **Sign in with GitHub** in the **Sign-In** section of Administration. The sign-in page now offers it.
- [ ] Give the editor a GitHub username in the **Users** section. The editor signs in with that GitHub account in the popup, and lands signed in as the editor. The **Users** section shows the account as linked.
- [ ] A GitHub account that no user has and no sign-up rule covers is refused, with a message saying they aren’t invited.
- [ ] **Link GitHub Account** in the account menu, for a password user: after the popup, they can sign in either way.
- [ ] A user who signed in with GitHub commits with their own token: on GitHub, the commit is theirs, as when they commit directly.
- [ ] After 8 hours, the GitHub user token expires and is refreshed on its own. After the refresh token’s 6 months, or once the user revokes the app in their GitHub settings, the CMS falls back to the app’s token without signing out.
- [ ] **Sign-up rules**: add a rule for a GitHub organization the second account belongs to, with a role. Signing in with it creates the user with that role, listed as a rule member. Remove them from the organization: at their next sign-in with GitHub, they’re disabled and signed out, and the audit log says why. An adopted member isn’t checked against the rule, and keeps signing in. If GitHub can’t answer the membership check, e.g. while it’s down, the sign-in fails with a GitHub error, but the account isn’t disabled.
- [ ] Popup blockers: with popups blocked, the CMS says so rather than waiting forever, and **Cancel** gets out of the pending sign-in.
- [ ] The popup works in Safari and Firefox as well as Chrome (`Cross-Origin-Opener-Policy`).

## 7. Entry locks

Sign in as the admin in browser **A** and the editor in browser **B**:

- [ ] **A** opens an entry. Within a second or two, **B**’s entry list shows it as being edited by **A**.
- [ ] **B** opens it: the editor is read-only, with a notice naming **A** and since when, and **Take Over**.
- [ ] **B** takes over: **A**’s editor becomes read-only at once, saying **B** took over. **A**’s unsaved changes are still in the draft backup.
- [ ] **B** closes the entry: **A** gets the lock back.
- [ ] Reloading the page keeps the lock: a closed connection’s locks are kept for 30 seconds.
- [ ] Closing the tab, not the editor, releases the lock after those 30 seconds.
- [ ] The same person opening the entry in a second tab: each tab is its own connection, so the second tab should show it as locked, by themselves. Note what it says, and whether that reads sensibly.
- [ ] The viewer opening the entry doesn’t take a lock, and sees who holds it.
- [ ] With Editorial Workflow, the same entry on its workflow branch and on the default branch can be edited at once; locks are per branch.
- [ ] Turn off the network on **A** for a minute and back on: the socket reconnects, and **A** sees the locks taken meanwhile.
- [ ] Leave both idle for over an hour: the locks and the socket still work, after the Durable Object has hibernated.
- [ ] **Who else has it open:** with **A** editing an entry, the viewer and **B** open it too. **A** sees their initials next to the entry title, with their names on hover; **B** and the viewer see the others. Nobody sees themselves.
- [ ] In the entry list, the entry shows **A**’s editing icon and, next to it, an eye with the number of other people who have it open, leaving out **A**.
- [ ] Closing the editor or the tab takes the person off at once, unlike a lock, which waits 30 seconds. After a reload they’re back once the editor opens again.

## 8. Comments

Still in browsers **A** and **B**, on an existing entry:

- [ ] The **Conversation** tab in the editor’s sidebar is disabled for a new entry, and enabled once it’s saved.
- [ ] **A** comments, with Markdown: a list, a link, code and an image. It shows rendered, and links open in a new tab.
- [ ] **B**’s editor shows **A**’s comment within a second or two, without reloading, and the tab’s count goes up, even while another panel is open.
- [ ] The count also updates on a tab whose editor is closed, the next time an entry is opened.
- [ ] HTML in a comment (`<script>`, `<img onerror>`, a `javascript:` link) is shown harmlessly.
- [ ] **A** edits their own comment, which shows as edited in both browsers. **B** has no options on **A**’s comments.
- [ ] **B** deletes their own comment. The admin deletes **B**’s comment, which is written to the audit log.
- [ ] The viewer can comment.
- [ ] Comments are shared between an entry’s locales, and between the default branch and its workflow branch.
- [ ] Rename an entry with comments (change its slug): the comments follow it.
- [ ] Delete an entry with comments: its comments are deleted.
- [ ] With Editorial Workflow, discard a new, never-published draft with comments: its comments are deleted. Rename a published entry in a draft, comment, then discard the draft: the comments go back to the published entry.
- [ ] More than 30 comments in a minute are refused with a clear message.

## 9. Shared credentials

Turn on a service that takes a key in the test site’s configuration, e.g. a translation service, and a cloud storage bucket with `media_libraries`, and give the configuration `skip_ci` so the deploy hook is offered.

- [ ] As the admin, **Administration** › **Credentials** lists those services and the deploy hook. A key in the wrong format, e.g. a DeepL key without `:fx` for the free API, is refused with a message naming the service.
- [ ] Save a translation key, a cloud storage key and a deploy hook. In browser **B**, signed in as the editor, without reloading: translating a field works, the bucket can be browsed and uploaded to, and **Publish Changes** calls the hook. `wrangler tail` shows `GET /v1/credentials` after the save.
- [ ] In browser **B**, Settings shows **Provided by your administrator** in those fields. Entering a key of their own is used instead, e.g. a wrong one makes translating fail; clearing it goes back to the admin’s.
- [ ] Signing out of browser **B** leaves no shared key in its local storage or IndexedDB.
- [ ] The viewer gets the keys too, e.g. can browse the bucket, but still can’t upload.
- [ ] Removing a key under **Credentials** stops it working for everyone at once.

## 10. Several sites

With the same Worker, after the sections above have set up the default site:

- [ ] The setup wizard of the default site offers **Manage Other Sites**, which lists no sites yet. **Add Site** creates a tenant, e.g. `acme`, and shows its URL with a copy button. An ID that’s taken, `default`, or not lower-case is refused with a message.
- [ ] `POST /v1/tenants` with the admin secret creates a tenant too, which the wizard lists after **Back to Sign In** and the secret again. A wrong secret is refused.
- [ ] A second test site’s CMS with `base_url` set to that URL opens the setup wizard: create its admin and its GitHub App, installed on a second test repository. The app’s name ends with a few characters that differ from the first site’s.
- [ ] The two sites share nothing: the first site’s users can’t sign in to the second, its sessions are refused there, an entry locked in one shows unlocked in the other, comments stay in their site, and each site’s allowed domains apply only to it.
- [ ] Sign in with GitHub and a token refresh work for the second site, whose callback URLs include `/t/acme`.
- [ ] Wrong admin secrets tried on both sites together are rate-limited together.
- [ ] The second site’s setup wizard doesn’t offer **Manage Other Sites**.
- [ ] Deleting `acme` in the first site’s wizard, after typing its ID to confirm, deletes the site: its CMS can no longer sign in, and the first site is unaffected.

## 11. Updates and limits

- [ ] Once a newer version of `@sveltia/cms-additions` is on npm, the Administration page says so, with a link to the releases. Until the first release, there is nothing to test: the notice stays hidden when the registry has no such package.
- [ ] `wrangler tail` shows no request over the Free plan’s 10 ms of CPU, apart from the first after a deploy. Look at sign-in, `/v1/auth/session` when it mints a token, and `/v1/auth/token`.
- [ ] Deleting a user or signing them out revokes their GitHub tokens within a few minutes, even if GitHub was briefly unreachable (`pending_token_revocations` in the Users list goes back to 0).

## When something fails

Write down the browser, the time, what you did and what you expected, and copy the error from the browser console and `wrangler tail`. A failure in a flow the end-to-end tests cover usually means the mock differs from the real service or GitHub: fix the code, then teach the mock the real behaviour so the test catches it next time.
