/**
 * Tenant of a request, set by the Worker for the Durable Object. The Worker overwrites whatever a
 * client sends, and the Durable Object can only be reached through the Worker.
 */
export const TENANT_HEADER = 'x-additions-tenant';

/**
 * URL the tenant is reached at, set by the Worker like {@link TENANT_HEADER}.
 */
export const BASE_URL_HEADER = 'x-additions-base-url';

/**
 * Tenant served at the root of the Worker, which is the only one of a single-site deployment. It
 * exists without being created.
 */
export const DEFAULT_TENANT = 'default';

/**
 * A tenant ID: lower-case letters, digits and hyphens, 1 to 32 characters, starting and ending
 * with a letter or a digit. It appears in the tenant’s URL, e.g. `/t/acme`.
 */
export const TENANT_ID_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * Path of a tenant’s requests: `/t/<tenant ID>`, followed by the path within the tenant.
 */
const TENANT_PATH_REGEX = /^\/t\/(?<tenant>[^/]+)(?<path>\/.*)?$/;

/**
 * Find out which tenant a request is for.
 * @param {URL} url Request URL.
 * @returns {{ tenant: string, path: string, basePath: string } | null} Tenant, the path within the
 * tenant, and the path the tenant is served at, or `null` for a path under `/t/` that names no
 * valid tenant.
 */
export const resolveTenant = ({ pathname }) => {
  if (!pathname.startsWith('/t/')) {
    return { tenant: DEFAULT_TENANT, path: pathname, basePath: '' };
  }

  const { tenant = '', path = '/' } = pathname.match(TENANT_PATH_REGEX)?.groups ?? {};

  // The default tenant is only served at the root, so its links never change
  if (!TENANT_ID_REGEX.test(tenant) || tenant === DEFAULT_TENANT) {
    return null;
  }

  return { tenant, path, basePath: `/t/${tenant}` };
};

/**
 * Get the Durable Object of a tenant, which holds its database, locks and background jobs.
 * @param {Record<string, any>} env Bindings.
 * @param {string} tenant Tenant ID.
 * @returns {DurableObjectStub<import('./durable-object.js').AdditionsDurableObject>} Stub.
 */
export const getTenantObject = (env, tenant) =>
  env.DURABLE_OBJECT.get(env.DURABLE_OBJECT.idFromName(`tenant:${tenant}`));

/**
 * Get the Durable Object that lists the tenants, and counts what has to be counted across all of
 * them, such as attempts at the admin secret every tenant shares.
 * @param {Record<string, any>} env Bindings.
 * @returns {DurableObjectStub<import('./durable-object.js').AdditionsDurableObject>} Stub.
 */
export const getRegistryObject = (env) =>
  env.DURABLE_OBJECT.get(env.DURABLE_OBJECT.idFromName('registry'));
