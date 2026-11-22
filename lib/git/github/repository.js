import { fetchGitHub } from './api.js';

/**
 * Rules a ruleset needs on the default branch to keep editors from rewriting or deleting it.
 */
export const REQUIRED_BRANCH_RULES = ['non_fast_forward', 'deletion'];

/**
 * How well the default branch is protected:
 * - `protected`: rulesets block force pushes and deletion, and the app can’t bypass them;
 * - `bypassed`: such rules exist, but the app is on a bypass list;
 * - `unprotected`: a rule is missing.
 * @typedef {'protected' | 'bypassed' | 'unprotected'} BranchProtection
 */

/**
 * Check whether rulesets protect a repository’s default branch from force pushes and deletion, as
 * the installation token sees them. Only rulesets are checked: classic branch protection rules
 * can’t be read without the `administration` permission, which the app doesn’t ask for.
 * @param {string} token Installation token with `metadata: read`.
 * @param {{ owner: string, name: string }} repository Repository.
 * @returns {Promise<{ name: string, protection: BranchProtection }>} Default branch and its
 * protection.
 * @throws {import('./api.js').GitHubError} If GitHub refuses or fails.
 */
export const getDefaultBranchProtection = async (token, { owner, name }) => {
  const auth = `Bearer ${token}`;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  /** @type {{ default_branch: string }} */
  const { default_branch: branch } = await fetchGitHub(path, { auth });

  /** @type {{ type: string, ruleset_id: number }[]} */
  const rules = // A branch name can have slashes, which GitHub takes as they are
    (
      await fetchGitHub(
        `${path}/rules/branches/${branch.split('/').map(encodeURIComponent).join('/')}?per_page=100`,
        {
          auth,
        },
      )
    ).filter(({ type }) => REQUIRED_BRANCH_RULES.includes(type));

  // The rules don’t say who can bypass them; their rulesets do, for the token’s owner: the app
  const rulesetsAppCanBypass = new Set(
    await Promise.all(
      [...new Set(rules.map(({ ruleset_id: id }) => id))].map(async (id) => {
        /** @type {{ current_user_can_bypass?: string }} */
        const ruleset = await fetchGitHub(`${path}/rulesets/${id}`, { auth });

        return ruleset.current_user_can_bypass === 'always' ? id : undefined;
      }),
    ),
  );

  /**
   * Check whether a rule of a type applies to the branch.
   * @param {string} type Rule type.
   * @returns {boolean} Result.
   */
  const isPresent = (type) => rules.some((rule) => rule.type === type);

  /**
   * Check whether a rule of a type applies to the branch and the app can’t bypass it.
   * @param {string} type Rule type.
   * @returns {boolean} Result.
   */
  const isEnforced = (type) =>
    rules.some((rule) => rule.type === type && !rulesetsAppCanBypass.has(rule.ruleset_id));

  /** @type {BranchProtection} */
  let protection = 'unprotected';

  if (REQUIRED_BRANCH_RULES.every(isEnforced)) {
    protection = 'protected';
  } else if (REQUIRED_BRANCH_RULES.every(isPresent)) {
    protection = 'bypassed';
  }

  return { name: branch, protection };
};
