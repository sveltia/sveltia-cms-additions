import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getRateLimitMessage } from './api.js';

const NOW = Date.UTC(2026, 10, 22);

/**
 * Create a response.
 * @param {number} status Status.
 * @param {Record<string, string>} [headers] Headers.
 * @returns {Response} Response.
 */
const createResponse = (status, headers = {}) => new Response(null, { status, headers });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getRateLimitMessage()', () => {
  test('tells when the hourly limit resets', () => {
    const response = createResponse(403, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(NOW / 1000 + 30),
    });

    expect(getRateLimitMessage(response, undefined, true)).toBe(
      'GitHub is limiting the requests this service sends. Try again in 1 minute.',
    );
    expect(getRateLimitMessage(response, undefined, false)).toBe(
      'GitHub is limiting requests from the network address this service shares with others. ' +
        'Try again in 1 minute.',
    );
  });

  test('follows `Retry-After` for a secondary rate limit', () => {
    expect(
      getRateLimitMessage(createResponse(429, { 'retry-after': '120' }), undefined, true),
    ).toBe('GitHub is limiting the requests this service sends. Try again in 2 minutes.');
  });

  test('says to try again later without a time', () => {
    expect(
      getRateLimitMessage(createResponse(403, { 'x-ratelimit-remaining': '0' }), undefined, true),
    ).toBe('GitHub is limiting the requests this service sends. Try again later.');
  });

  test('recognizes a secondary rate limit by its message', () => {
    expect(
      getRateLimitMessage(
        createResponse(403, { 'x-ratelimit-remaining': '4000' }),
        'You have exceeded a secondary rate limit.',
        true,
      ),
    ).toBe('GitHub is limiting the requests this service sends. Try again later.');
  });

  test('ignores other errors', () => {
    expect(
      getRateLimitMessage(
        createResponse(403, { 'x-ratelimit-remaining': '42' }),
        'Forbidden',
        true,
      ),
    ).toBe(null);
    expect(
      getRateLimitMessage(createResponse(404, { 'x-ratelimit-remaining': '0' }), undefined, true),
    ).toBe(null);
  });
});
