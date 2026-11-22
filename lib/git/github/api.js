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
   * @param {object} [options] Options.
   * @param {boolean} [options.rateLimited] Whether GitHub refused because it’s limiting requests.
   */
  constructor(githubStatus, message, { rateLimited = false } = {}) {
    super('github_error', githubStatus, message);
    this.name = 'GitHubError';
    this.githubStatus = githubStatus;
    this.rateLimited = rateLimited;
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
 * Get the message for GitHub limiting requests, if it is: a 403 or 429 with no requests left, with
 * a `Retry-After` header, or with a message saying so, as for a secondary rate limit that comes
 * with neither header.
 * @param {Response} response Response.
 * @param {string | undefined} githubMessage Message in the response body.
 * @param {boolean} authenticated Whether the request had credentials. GitHub limits those without
 * by IP address, which a Cloudflare Worker shares with others, so they can run out at any time.
 * @returns {string | null} Message, or `null` if GitHub isn’t limiting requests.
 */
export const getRateLimitMessage = (response, githubMessage, authenticated) => {
  const { status, headers } = response;
  const retryAfter = Number(headers.get('retry-after'));
  const reset = Number(headers.get('x-ratelimit-reset'));

  if (
    ![403, 429].includes(status) ||
    (headers.get('x-ratelimit-remaining') !== '0' &&
      !retryAfter &&
      !/rate limit/i.test(githubMessage ?? ''))
  ) {
    return null;
  }

  const seconds = retryAfter || (reset ? reset - Date.now() / 1000 : 0);
  const minutes = Math.max(1, Math.ceil(seconds / 60));

  return [
    authenticated
      ? 'GitHub is limiting the requests this service sends.'
      : 'GitHub is limiting requests from the network address this service shares with others.',
    seconds > 0 ? `Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` : 'Try again later.',
  ].join(' ');
};

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

    const rateLimitMessage = getRateLimitMessage(response, details?.message, !!options?.auth);

    if (rateLimitMessage) {
      throw new GitHubError(response.status, rateLimitMessage, { rateLimited: true });
    }

    throw new GitHubError(
      response.status,
      `GitHub responded with ${response.status}${details?.message ? `: ${details.message}` : ''}.`,
    );
  }

  return response.json();
};
