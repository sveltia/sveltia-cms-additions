import { describe, expect, test } from 'vitest';

import { MAX_API_KEYS, MAX_VALUE_LENGTH, validateCredentials } from './credentials.js';

describe('validateCredentials()', () => {
  test('keeps the API keys and the deploy hook, trimmed, and drops empty values', () => {
    expect(
      validateCredentials({
        api_keys: { deepl: ' abc:fx ', 'cloudflare-r2': 'secret', google: '' },
        deploy_hook: { url: 'https://api.netlify.com/build_hooks/1', auth_header: '' },
      }),
    ).toEqual({
      api_keys: { deepl: 'abc:fx', 'cloudflare-r2': 'secret' },
      deploy_hook: { url: 'https://api.netlify.com/build_hooks/1', auth_header: '' },
    });

    // Nothing at all, or a deploy hook without a URL
    expect(validateCredentials({})).toEqual({ api_keys: {}, deploy_hook: null });
    expect(validateCredentials({ deploy_hook: { url: ' ', auth_header: 'Bearer x' } })).toEqual({
      api_keys: {},
      deploy_hook: null,
    });
    expect(validateCredentials({ deploy_hook: { url: 'https://example.com/hook' } })).toEqual({
      api_keys: {},
      deploy_hook: { url: 'https://example.com/hook', auth_header: '' },
    });
  });

  test.each([
    [null, 'must be an object'],
    [[], 'must be an object'],
    [{ api_keys: [] }, '`api_keys` must be an object'],
    [{ api_keys: null }, '`api_keys` must be an object'],
    [{ api_keys: { 'not a service': 'x' } }, 'is not a service ID'],
    [{ api_keys: { deepl: 42 } }, 'must be a single line'],
    [{ api_keys: { deepl: 'a\nb' } }, 'must be a single line'],
    [{ api_keys: { deepl: 'a\u0000b' } }, 'must be a single line'],
    [{ api_keys: { deepl: 'x'.repeat(MAX_VALUE_LENGTH + 1) } }, 'must be a single line'],
    [
      {
        api_keys: Object.fromEntries(
          Array.from({ length: MAX_API_KEYS + 1 }, (_, index) => [`s${index}`, 'x']),
        ),
      },
      `up to ${MAX_API_KEYS} API keys`,
    ],
    [{ deploy_hook: 'https://example.com' }, '`deploy_hook` must be an object'],
    [{ deploy_hook: [] }, '`deploy_hook` must be an object'],
    [{ deploy_hook: { url: 'http://example.com/hook' } }, 'must start with `https://`'],
    [{ deploy_hook: { url: 'not a URL' } }, 'must start with `https://`'],
    [{ deploy_hook: { url: 'https://example.com', auth_header: 'a\r\nb' } }, 'single line'],
  ])('refuses %j', (input, message) => {
    expect(() => validateCredentials(input)).toThrow(message);
  });
});
