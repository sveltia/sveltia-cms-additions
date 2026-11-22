import { HttpError } from './http/errors.js';
import { getSetting, setSetting } from './settings.js';

/**
 * @import { Database } from '../types.js';
 */

/**
 * Setting key of the allowed domain list.
 */
export const ALLOWED_DOMAINS_SETTING = 'allowed_domains';

/**
 * How long the list is cached in an isolate. Changes made in another isolate take effect here within
 * this time.
 */
const CACHE_TTL = 60 * 1000;

/**
 * Hostnames that may be served over plain HTTP, for local development, when the list names them.
 */
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1'];

/**
 * A hostname, optionally starting with a wildcard label (`*.`) followed by at least two labels, e.g.
 * `*.example.com`. A wildcard anywhere else, e.g. `example.*` or `*example.com`, would match
 * hostnames anyone can register, and the list also decides where sign-in codes may be sent.
 */
const DOMAIN_REGEX =
  /^(?:\*\.(?=[^.]+\.[^.]+))?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Check whether an entry of the list is valid.
 * @param {string} domain Entry.
 * @returns {boolean} Result.
 */
const isValidDomain = (domain) => DOMAIN_REGEX.test(domain);

/**
 * Cached lists, by database: every tenant has its own, and several tenants can share an isolate.
 * @type {WeakMap<Database, { domains: string[], expires: number }>}
 */
let caches = new WeakMap();

/**
 * Clear the cached list. Called after the list changes, and by tests.
 * @param {Database} [db] Database whose list to clear. Default: every database’s.
 */
export const clearAllowedDomainsCache = (db) => {
  if (db) {
    caches.delete(db);
  } else {
    caches = new WeakMap();
  }
};

/**
 * Escape the given string for safe use in a regular expression.
 * @param {string} str Original string.
 * @returns {string} Escaped string.
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions#escaping
 */
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Convert allowed domains into anchored regular expressions. A leading `*.` matches one or more
 * labels, so `*.example.com` matches `www.example.com` and `docs.api.example.com` but not
 * `example.com`. An entry saved before the wildcard rules were tightened, e.g. `example.*`, no
 * longer matches anything.
 * @param {string[]} domains Allowed domains.
 * @returns {RegExp[]} Regular expressions.
 */
export const getDomainPatterns = (domains) =>
  domains
    .filter(isValidDomain)
    .map((domain) => new RegExp(`^${escapeRegExp(domain).replace(/^\\\*/, '.+')}$`));

/**
 * Normalize and validate a list of allowed domains entered by an admin.
 * @param {unknown} domains List to check.
 * @returns {string[]} Lower-cased, trimmed and deduplicated list.
 * @throws {HttpError} If the list or any entry is invalid.
 */
export const normalizeAllowedDomains = (domains) => {
  if (!Array.isArray(domains)) {
    throw new HttpError(400, 'invalid_domains', 'Allowed domains must be an array of hostnames.');
  }

  const normalized = domains.map((domain) =>
    typeof domain === 'string' ? domain.trim().toLowerCase() : '',
  );

  const invalid = normalized.find((domain) => !isValidDomain(domain));

  if (invalid !== undefined) {
    throw new HttpError(400, 'invalid_domains', `“${invalid}” is not a valid hostname.`);
  }

  return [...new Set(normalized)];
};

/**
 * Check whether a request origin is allowed by the given list. The scheme must be `https:`, except
 * for a loopback hostname, which may use `http:` when the list names it. Ports are ignored.
 * @param {string | null | undefined} origin Value of the `Origin` header.
 * @param {string[]} domains Allowed domains.
 * @returns {boolean} Result.
 */
export const isOriginAllowed = (origin, domains) => {
  if (!origin || !URL.canParse(origin)) {
    return false;
  }

  const { protocol, hostname } = new URL(origin);

  if (protocol !== 'https:' && !(protocol === 'http:' && LOOPBACK_HOSTNAMES.includes(hostname))) {
    return false;
  }

  return getDomainPatterns(domains).some((pattern) => pattern.test(hostname));
};

/**
 * Get the allowed domain list, cached for a minute.
 * @param {Database} db Database.
 * @returns {Promise<string[]>} Allowed domains. Empty until an admin adds one.
 */
export const getAllowedDomains = async (db) => {
  const cache = caches.get(db);

  if (cache && cache.expires > Date.now()) {
    return cache.domains;
  }

  const domains = /** @type {string[]} */ ((await getSetting(db, ALLOWED_DOMAINS_SETTING)) ?? []);

  caches.set(db, { domains, expires: Date.now() + CACHE_TTL });

  return domains;
};

/**
 * Replace the allowed domain list.
 * @param {Database} db Database.
 * @param {unknown} domains New list, validated with {@link normalizeAllowedDomains}.
 * @param {object} [options] Options.
 * @param {string | null} [options.actorId] ID of the user making the change, if any.
 * @param {string | null} [options.currentOrigin] Origin of the request making the change. The
 * change is refused if the new list would no longer allow it, so an admin can’t lock themselves out.
 * @returns {Promise<string[]>} Saved list.
 * @throws {HttpError} If the list is invalid or would lock out the current origin.
 */
export const setAllowedDomains = async (db, domains, { actorId = null, currentOrigin } = {}) => {
  const normalized = normalizeAllowedDomains(domains);

  if (currentOrigin && !isOriginAllowed(currentOrigin, normalized)) {
    throw new HttpError(
      409,
      'current_origin_removed',
      'The list must keep allowing the site you are making this change from.',
    );
  }

  await setSetting(db, ALLOWED_DOMAINS_SETTING, normalized, { actorId });
  clearAllowedDomainsCache(db);

  return normalized;
};

/**
 * Add the hostname of an origin to the allowed domain list, unless it’s already allowed.
 * @param {Database} db Database.
 * @param {string} origin Origin, e.g. `https://www.example.com`.
 * @returns {Promise<string[]>} Allowed domains after the change.
 * @throws {HttpError} If the origin isn’t a valid `https:` or loopback origin.
 */
export const addAllowedOrigin = async (db, origin) => {
  clearAllowedDomainsCache(db);

  // Entries saved before the wildcard rules were tightened match nothing, and are dropped
  const domains = (await getAllowedDomains(db)).filter(isValidDomain);

  if (isOriginAllowed(origin, domains)) {
    return domains;
  }

  const { hostname } = URL.canParse(origin) ? new URL(origin) : { hostname: '' };
  const updated = normalizeAllowedDomains([...domains, hostname]);

  if (!isOriginAllowed(origin, updated)) {
    throw new HttpError(400, 'invalid_origin', 'Only HTTPS and loopback origins can be allowed.');
  }

  await setSetting(db, ALLOWED_DOMAINS_SETTING, updated);
  clearAllowedDomainsCache(db);

  return updated;
};
