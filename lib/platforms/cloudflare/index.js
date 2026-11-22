import { errorResponse } from '../../core/http/errors.js';

import { AdditionsDurableObject } from './durable-object.js';
import { createOperatorApp } from './operator.js';
import { BASE_URL_HEADER, getTenantObject, resolveTenant, TENANT_HEADER } from './tenants.js';

const operatorApp = createOperatorApp();

/**
 * Route a request: the operator API to the Worker itself, and anything else to the Durable Object
 * of the tenant it’s for, where the app runs with the tenant’s own database. A single-site
 * deployment only has the default tenant, served at the root; any other tenant is served under
 * `/t/<tenant ID>`, which the CMS configuration’s `base_url` includes.
 * @param {Request} request Request.
 * @param {Record<string, any>} env Bindings.
 * @param {ExecutionContext} ctx Context.
 * @returns {Promise<Response>} Response.
 */
const fetch = async (request, env, ctx) => {
  const url = new URL(request.url);

  if (url.pathname === '/v1/tenants' || url.pathname.startsWith('/v1/tenants/')) {
    return operatorApp.fetch(request, env, ctx);
  }

  const route = resolveTenant(url);

  if (!route) {
    return errorResponse(404, 'tenant_not_found', 'There is no such site.');
  }

  const target = new URL(url);

  target.pathname = route.path;

  const forwarded = new Request(target, request);

  // Overwrite whatever the client sent: the Durable Object trusts these
  forwarded.headers.set(TENANT_HEADER, route.tenant);
  forwarded.headers.set(BASE_URL_HEADER, `${url.origin}${route.basePath}`);

  return getTenantObject(env, route.tenant).fetch(forwarded);
};

export default { fetch };

export { AdditionsDurableObject };
