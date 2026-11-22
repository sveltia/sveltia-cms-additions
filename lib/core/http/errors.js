/**
 * Error that becomes a JSON error response: `{ error: { code, message } }`. The CMS maps `code` to
 * a localized string, so codes are stable while messages are for developers.
 */
export class HttpError extends Error {
  /**
   * Create an error.
   * @param {number} status HTTP status.
   * @param {string} code Stable, machine-readable error code.
   * @param {string} message Developer-facing message.
   * @param {Record<string, string>} [headers] Extra response headers, e.g. `Retry-After`.
   */
  constructor(status, code, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * Create a JSON error response.
 * @param {number} status HTTP status.
 * @param {string} code Error code.
 * @param {string} message Error message.
 * @param {Record<string, string>} [headers] Extra response headers.
 * @returns {Response} Response.
 */
export const errorResponse = (status, code, message, headers = {}) =>
  Response.json({ error: { code, message } }, { status, headers });

/**
 * Make an app answer every error, and a path it doesn’t know, with a JSON error response. An
 * {@link HttpError} gives its own status and code; anything else is logged and reported as an
 * internal error, without the details.
 * @param {import('hono').Hono<any>} app App.
 */
export const useJsonErrors = (app) => {
  app.onError((error) => {
    if (error instanceof HttpError) {
      return errorResponse(error.status, error.code, error.message, error.headers);
    }

    // eslint-disable-next-line no-console
    console.error(error);

    return errorResponse(500, 'internal_error', 'Something went wrong.');
  });

  app.notFound(() => errorResponse(404, 'not_found', 'There is nothing here.'));
};
