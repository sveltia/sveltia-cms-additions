import { HttpError } from './errors.js';

/**
 * @import { Context } from 'hono';
 * @import { AppEnv } from '../../types.js';
 */

/**
 * Read the JSON body of a request.
 * @param {Context<AppEnv>} c Hono context.
 * @returns {Promise<Record<string, any>>} Parsed body.
 * @throws {HttpError} If the body isn’t a JSON object.
 */
export const readJson = async (c) => {
  /** @type {unknown} */
  let body;

  try {
    body = await c.req.json();
  } catch {
    body = undefined;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_body', 'The request body must be a JSON object.');
  }

  return /** @type {Record<string, any>} */ (body);
};
