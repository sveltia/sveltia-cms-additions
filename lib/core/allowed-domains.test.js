import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { migrations } from '../../migrations/index.js';
import { getTestDatabase } from '../test/helpers.js';

import {
  addAllowedOrigin,
  clearAllowedDomainsCache,
  getAllowedDomains,
  getDomainPatterns,
  isOriginAllowed,
  normalizeAllowedDomains,
  setAllowedDomains,
} from './allowed-domains.js';
import { migrate } from './db/migrate.js';

const db = getTestDatabase('allowed-domains');

beforeAll(async () => {
  await migrate(db, migrations);
});

beforeEach(async () => {
  await db.run('DELETE FROM setting');
  clearAllowedDomainsCache();
});

describe('getDomainPatterns()', () => {
  test('ignores an entry saved before the wildcard rules were tightened', () => {
    expect(getDomainPatterns(['example.*', '*example.com', 'www.example.com'])).toHaveLength(1);
  });

  test('matches like Sveltia CMS Authenticator', () => {
    const [exact, wildcard] = getDomainPatterns(['www.example.com', '*.example.org']);

    expect(exact.test('www.example.com')).toBe(true);
    expect(exact.test('wwwxexample.com')).toBe(false);
    expect(exact.test('evil.www.example.com')).toBe(false);
    expect(wildcard.test('www.example.org')).toBe(true);
    expect(wildcard.test('docs.api.example.org')).toBe(true);
    expect(wildcard.test('example.org')).toBe(false);
  });
});

describe('normalizeAllowedDomains()', () => {
  test('trims, lower-cases and deduplicates', () => {
    expect(
      normalizeAllowedDomains([' WWW.Example.com', 'www.example.com', '*.example.org']),
    ).toEqual(['www.example.com', '*.example.org']);
  });

  test('rejects invalid entries', () => {
    expect(() => normalizeAllowedDomains('www.example.com')).toThrow('must be an array');
    expect(() => normalizeAllowedDomains(['https://www.example.com'])).toThrow('not a valid');
    expect(() => normalizeAllowedDomains(['www.example.com:8080'])).toThrow('not a valid');
    expect(() => normalizeAllowedDomains(['*'])).toThrow('not a valid');

    // A wildcard that anyone could satisfy by registering a domain
    ['**', '*.*', 'example.*', '*example.com', 'www.*.com', '*.com'].forEach((domain) => {
      expect(() => normalizeAllowedDomains([domain])).toThrow('not a valid');
    });
    expect(() => normalizeAllowedDomains([''])).toThrow('not a valid');
    expect(() => normalizeAllowedDomains([42])).toThrow('not a valid');
  });
});

describe('isOriginAllowed() with old entries', () => {
  test('refuses an origin only a loose wildcard saved earlier would match', () => {
    expect(isOriginAllowed('https://example.attacker.net', ['example.*'])).toBe(false);
  });
});

describe('isOriginAllowed()', () => {
  const domains = ['www.example.com', '*.example.org', 'localhost'];

  test('allows a listed HTTPS origin, ignoring the port', () => {
    expect(isOriginAllowed('https://www.example.com', domains)).toBe(true);
    expect(isOriginAllowed('https://www.example.com:8443', domains)).toBe(true);
    expect(isOriginAllowed('https://cms.example.org', domains)).toBe(true);
  });

  test('refuses unlisted and plain HTTP origins', () => {
    expect(isOriginAllowed('https://example.com', domains)).toBe(false);
    expect(isOriginAllowed('http://www.example.com', domains)).toBe(false);
    expect(isOriginAllowed('null', domains)).toBe(false);
    expect(isOriginAllowed(undefined, domains)).toBe(false);
  });

  test('allows plain HTTP for a listed loopback hostname only', () => {
    expect(isOriginAllowed('http://localhost:5173', domains)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:5173', domains)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:5173', ['127.0.0.1'])).toBe(true);
  });

  test('refuses everything when the list is empty', () => {
    expect(isOriginAllowed('https://www.example.com', [])).toBe(false);
  });
});

describe('setAllowedDomains()', () => {
  test('saves a normalized list', async () => {
    await expect(setAllowedDomains(db, ['WWW.example.com'])).resolves.toEqual(['www.example.com']);
    await expect(getAllowedDomains(db)).resolves.toEqual(['www.example.com']);
  });

  test('refuses to remove the origin making the change', async () => {
    await expect(
      setAllowedDomains(db, ['cms.example.com'], { currentOrigin: 'https://www.example.com' }),
    ).rejects.toThrow('keep allowing');
  });
});

describe('addAllowedOrigin()', () => {
  test('adds the hostname of an origin once', async () => {
    await expect(addAllowedOrigin(db, 'https://www.example.com')).resolves.toEqual([
      'www.example.com',
    ]);
    await expect(addAllowedOrigin(db, 'https://www.example.com:8443')).resolves.toEqual([
      'www.example.com',
    ]);
  });

  test('drops an entry saved before the wildcard rules were tightened', async () => {
    await db.run('INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)', [
      'allowed_domains',
      JSON.stringify(['example.*']),
      Date.now(),
    ]);
    clearAllowedDomainsCache();

    await expect(addAllowedOrigin(db, 'https://www.example.com')).resolves.toEqual([
      'www.example.com',
    ]);
  });

  test('refuses a plain HTTP origin that isn’t loopback', async () => {
    await expect(addAllowedOrigin(db, 'http://www.example.com')).rejects.toThrow('Only HTTPS');
    await expect(addAllowedOrigin(db, 'not a url')).rejects.toThrow('not a valid');
  });
});
