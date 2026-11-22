import { ProviderError } from '../../core/git-provider.js';

/**
 * Base URL of the GitHub REST API.
 */
export const GITHUB_API_ROOT = 'https://api.github.com';

/**
 * How long a request to GitHub may take before it’s given up, so a stalled request doesn’t hold
 * up a tenant’s Durable Object, which handles all of the tenant’s requests.
 */
export const GITHUB_TIMEOUT = 15 * 1000;

/**
 * Error returned by the GitHub API.
 */
export class GitHubError extends ProviderError {
  /**
   * Create an error.
   * @param {number} githubStatus Status GitHub responded with.
   * @param {string} message Message.
   */
  constructor(githubStatus, message) {
    super('github_error', githubStatus, message);
    this.name = 'GitHubError';
    this.githubStatus = githubStatus;
  }
}

/**
 * Send a request to the GitHub REST API.
 * @param {string} path Path, e.g. `/app/installations/1`.
 * @param {object} [options] Options.
 * @param {string} [options.method] Method.
 * @param {string} [options.auth] `Authorization` header value, e.g. `Bearer <JWT>`.
 * @param {any} [options.body] JSON body.
 * @returns {Promise<Response>} Response, whatever its status.
 */
export const sendGitHubRequest = (path, { method = 'GET', auth, body } = {}) =>
  fetch(`${GITHUB_API_ROOT}${path}`, {
    method,
    signal: AbortSignal.timeout(GITHUB_TIMEOUT),
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'sveltia-cms-additions',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(auth ? { Authorization: auth } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

/**
 * Send a request to the GitHub REST API and return the JSON response.
 * @template T
 * @param {string} path Path.
 * @param {object} [options] Options for {@link sendGitHubRequest}.
 * @param {string} [options.method] Method.
 * @param {string} [options.auth] `Authorization` header value.
 * @param {any} [options.body] JSON body.
 * @returns {Promise<T>} Parsed response.
 * @throws {GitHubError} If GitHub responds with an error.
 */
export const fetchGitHub = async (path, options) => {
  const response = await sendGitHubRequest(path, options);

  if (!response.ok) {
    /** @type {any} */
    let details;

    try {
      details = await response.json();
    } catch {
      details = undefined;
    }

    throw new GitHubError(
      response.status,
      `GitHub responded with ${response.status}${details?.message ? `: ${details.message}` : ''}.`,
    );
  }

  return response.json();
};
