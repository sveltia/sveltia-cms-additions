import { Hono } from 'hono';

import { verifyAdminSecret } from '../../core/admin-secret.js';
import { readJson } from '../../core/http/body.js';
import { cors } from '../../core/http/cors.js';
import { HttpError, useJsonErrors } from '../../core/http/errors.js';

import { DEFAULT_TENANT, getRegistryObject, getTenantObject, TENANT_ID_REGEX } from './tenants.js';

/**
 * @import { AppEnv, Platform } from '../../types.js';
 * @import { Tenant } from './registry.js';
 */

/**
 * Longest tenant name accepted.
 */
const MAX_NAME_LENGTH = 100;

/**
 * Platform services the operator API needs: the admin secret check, whose attempts are counted in
 * the registry across every tenant.
 * @type {Pick<Platform, 'rateLimits'>}
 */
const operatorPlatform = {
  rateLimits: {
    /**
     * Count a request against a rate limit in the registry.
     * @param {Record<string, any>} env Bindings.
     * @param {string} key Counter key.
     * @param {{ limit: number, windowSeconds: number }} options Options.
     * @returns {Promise<import('../../types.js').RateLimitResult>} Result.
     */
    consume: (env, key, { limit, windowSeconds }) =>
      getRegistryObject(env).consumeRateLimit(key, limit, windowSeconds),
    /**
     * Take back a counted request.
     * @param {Record<string, any>} env Bindings.
     * @param {string} key Counter key.
     * @returns {Promise<void>}
     */
    refund: async (env, key) => {
      await getRegistryObject(env).refundRateLimit(key);
    },
  },
};

/**
 * Add the URL a tenant is served at, for the CMS configuration’s `base_url`.
 * @param {Tenant} tenant Tenant.
 * @param {string} origin Origin of the Worker.
 * @returns {Tenant & { url: string }} Tenant.
 */
const withURL = (tenant, origin) => ({ ...tenant, url: `${origin}/t/${tenant.id}` });

/**
 * Create the operator API, with which whoever runs the Worker, e.g. an agency, manages its tenants:
 * one per site, each with its own users, settings and GitHub App. It’s authenticated with
 * `ADMIN_SECRET`, like the setup wizard, which offers it on the default tenant, so it can be called
 * from any origin. A single-site deployment never needs it: its site is the default tenant, served
 * at the root.
 * @returns {Hono<AppEnv>} App.
 */
export const createOperatorApp = () => {
  /** @type {Hono<AppEnv>} */
  const app = new Hono();

  useJsonErrors(app);

  // Before the admin secret is checked: it answers preflights, which carry no secret, itself
  app.use(cors());

  app.use(async (c, next) => {
    await verifyAdminSecret(c, /** @type {Platform} */ (operatorPlatform));
    await next();
  });

  app.get('/v1/tenants', async (c) => {
    const { origin } = new URL(c.req.url);
    const tenants = await getRegistryObject(c.env).listTenants();

    return c.json({ tenants: tenants.map((tenant) => withURL(tenant, origin)) });
  });

  app.post('/v1/tenants', async (c) => {
    const { id, name = id } = await readJson(c);

    if (typeof id !== 'string' || !TENANT_ID_REGEX.test(id) || id === DEFAULT_TENANT) {
      throw new HttpError(
        400,
        'invalid_tenant_id',
        'The ID must be 1 to 32 lower-case letters, digits and hyphens, starting and ending with ' +
          `a letter or a digit, and can’t be “${DEFAULT_TENANT}”.`,
      );
    }

    if (typeof name !== 'string' || !name.trim() || name.length > MAX_NAME_LENGTH) {
      throw new HttpError(
        400,
        'invalid_tenant_name',
        `The name must be up to ${MAX_NAME_LENGTH} characters.`,
      );
    }

    const registry = getRegistryObject(c.env);
    /** @type {Tenant} */
    const tenant = { id, name: name.trim(), created_at: new Date().toISOString() };
    // Listed already: either a previous request failed halfway, or another request is creating it
    // right now. Whichever creates the site wins, and the list is made to match
    const listed = !(await registry.addTenant(tenant));

    if (listed && (await getTenantObject(c.env, id).hasTenant())) {
      throw new HttpError(409, 'tenant_exists', 'A site with this ID already exists.');
    }

    /** @type {Tenant} */
    let created;

    try {
      created = await getTenantObject(c.env, id).createTenant(tenant);
    } catch (error) {
      // Not listed unless it can be reached
      if (!listed) {
        await registry.removeTenant(id);
      }

      throw error;
    }

    // Another request created it meanwhile
    if (created.name !== tenant.name || created.created_at !== tenant.created_at) {
      throw new HttpError(409, 'tenant_exists', 'A site with this ID already exists.');
    }

    if (listed) {
      await registry.updateTenant(tenant);
    }

    return c.json({ tenant: withURL(tenant, new URL(c.req.url).origin) }, 201);
  });

  // Delete a tenant with all its data, which can’t be undone
  app.delete('/v1/tenants/:id', async (c) => {
    const id = c.req.param('id');

    if (!(await getRegistryObject(c.env).listTenants()).some((tenant) => tenant.id === id)) {
      throw new HttpError(404, 'tenant_not_found', 'There is no such site.');
    }

    // The data goes first, so a failure leaves the tenant listed, to be deleted again
    await getTenantObject(c.env, id).deleteTenant();
    await getRegistryObject(c.env).removeTenant(id);

    return c.json({ deleted: true });
  });

  return app;
};
