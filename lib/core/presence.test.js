import { describe, expect, test } from 'vitest';

import { MAX_KEY_LENGTH } from './locks.js';
import {
  handlePresenceMessage,
  listPresence,
  listViewers,
  MAX_CLIENT_SIZE,
  MAX_OPEN_ENTRIES,
} from './presence.js';

/**
 * @import { PresenceClient } from './presence.js';
 */

/** @type {PresenceClient} */
const ADA = { connection: 'c1', userId: 'u1', name: 'Ada', role: 'editor' };
/** @type {PresenceClient} */
const BOB = { connection: 'c2', userId: 'u2', name: 'Bob', role: 'viewer' };

/**
 * Serialize a message.
 * @param {Record<string, any>} message Message.
 * @returns {string} Raw message.
 */
const raw = (message) => JSON.stringify(message);

describe('handlePresenceMessage', () => {
  test('opens and closes entries, telling when something has changed', () => {
    expect(handlePresenceMessage(ADA, raw({ type: 'open', key: 'a' }))).toEqual({
      key: 'a',
      open: ['a'],
    });

    const client = { ...ADA, open: ['a'] };

    // Already open, or not open
    expect(handlePresenceMessage(client, raw({ type: 'open', key: 'a' }))).toEqual({});
    expect(handlePresenceMessage(client, raw({ type: 'close', key: 'b' }))).toEqual({});
    expect(handlePresenceMessage(client, raw({ type: 'close', key: 'a' }))).toEqual({
      key: 'a',
      open: [],
    });
    // A viewer can open an entry too
    expect(handlePresenceMessage(BOB, raw({ type: 'open', key: 'a' }))).toEqual({
      key: 'a',
      open: ['a'],
    });
  });

  test('leaves other messages to the locks', () => {
    expect(handlePresenceMessage(ADA, raw({ type: 'acquire', key: 'a' }))).toBeUndefined();
    expect(handlePresenceMessage(ADA, 'not json')).toBeUndefined();
    expect(handlePresenceMessage(ADA, new ArrayBuffer(8))).toBeUndefined();
  });

  test('refuses an invalid key, or too many open entries', () => {
    const invalid = { error: 'invalid_message' };

    expect(handlePresenceMessage(ADA, raw({ type: 'open' }))).toEqual(invalid);
    expect(handlePresenceMessage(ADA, raw({ type: 'close', key: 42 }))).toEqual(invalid);
    expect(
      handlePresenceMessage(ADA, raw({ type: 'open', key: 'x'.repeat(MAX_KEY_LENGTH + 1) })),
    ).toEqual(invalid);

    const full = { ...ADA, open: Array.from({ length: MAX_OPEN_ENTRIES }, (_, i) => `k${i}`) };

    expect(handlePresenceMessage(full, raw({ type: 'open', key: 'more' }))).toEqual({
      error: 'too_many_open',
    });

    // Long keys can fill the connection’s attachment before the count is reached, e.g. with a long
    // name
    const long = 'x'.repeat(MAX_KEY_LENGTH);
    const big = { ...ADA, name: 'y'.repeat(400), open: [`${long}1`.slice(1), `${long}2`.slice(1)] };

    expect(JSON.stringify(big).length).toBeLessThan(MAX_CLIENT_SIZE);
    expect(handlePresenceMessage(big, raw({ type: 'open', key: `${long}3`.slice(1) }))).toEqual({
      error: 'too_many_open',
    });

    // Counted in bytes, so keys in a script that takes several bytes a character fill it sooner
    const japanese = 'あ'.repeat(250);

    expect(
      handlePresenceMessage(
        { ...ADA, open: [`${japanese}1`, `${japanese}2`] },
        raw({ type: 'open', key: `${japanese}3` }),
      ),
    ).toEqual({ error: 'too_many_open' });
  });
});

describe('listViewers / listPresence', () => {
  const clients = [
    { ...ADA, open: ['a', 'b'] },
    { ...BOB, open: ['a'] },
    { ...ADA, connection: 'c3' },
  ];

  test('list who has an entry open, one per connection', () => {
    expect(listViewers(clients, 'a')).toEqual([
      { connection: 'c1', user_id: 'u1', name: 'Ada' },
      { connection: 'c2', user_id: 'u2', name: 'Bob' },
    ]);
    expect(listViewers(clients, 'c')).toEqual([]);
  });

  test('list everything open, for a new connection', () => {
    expect(listPresence(clients)).toEqual({
      a: [
        { connection: 'c1', user_id: 'u1', name: 'Ada' },
        { connection: 'c2', user_id: 'u2', name: 'Bob' },
      ],
      b: [{ connection: 'c1', user_id: 'u1', name: 'Ada' }],
    });
    expect(listPresence([])).toEqual({});
  });

  test('list entries whose keys are named like object properties', () => {
    const keys = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
    const presence = listPresence([{ ...ADA, open: keys }]);
    const viewer = { connection: 'c1', user_id: 'u1', name: 'Ada' };

    expect(Object.keys(presence)).toEqual(keys);
    keys.forEach((key) => expect(presence[key]).toEqual([viewer]));
    expect(JSON.parse(JSON.stringify(presence))).toEqual(
      Object.fromEntries(keys.map((key) => [key, [viewer]])),
    );
  });
});
