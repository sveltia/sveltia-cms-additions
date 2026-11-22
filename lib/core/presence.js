import { MAX_KEY_LENGTH, parseSocketMessage } from './locks.js';
import { adoptLockRows, hasOthersLocks } from './store/locks.js';
import {
  deleteStalePresenceRows,
  getPresenceRow,
  listPresenceRows,
  putPresenceRow,
} from './store/presence.js';

/**
 * @import { Database } from '../types.js';
 * @import { LockClient } from './locks.js';
 */

/**
 * How long a tab counts as open after its last heartbeat, where tabs send heartbeats instead of
 * keeping a connection open. The CMS sends one every 15 seconds.
 */
export const HEARTBEAT_TTL = 45 * 1000;

/**
 * A tab ID the CMS makes up, as it does for a WebSocket connection.
 */
const CONNECTION_REGEX = /^[\w-]{8,64}$/;

/**
 * Most entries a connection can have open at once. A CMS tab has one editor open; a couple more
 * leave room for an editor that’s closing as the next one opens.
 */
export const MAX_OPEN_ENTRIES = 3;

/**
 * Most bytes a client can take up once serialized. The list of open entries is kept in the
 * connection’s attachment, which Cloudflare limits to 2,048 bytes, along with the rest of the
 * client. It’s measured as UTF-8, which never takes fewer bytes than the attachment’s own encoding,
 * so a key in, say, Japanese is counted in full.
 */
export const MAX_CLIENT_SIZE = 1900;

/**
 * A connection, with the entries it has open in the editor. The list is kept with the connection
 * itself, not in the database: it means nothing once the connection has closed, and keeping it
 * there costs no storage reads or writes.
 * @typedef {LockClient & { open?: string[] }} PresenceClient
 */

/**
 * Someone with an entry open, as the clients are told.
 * @typedef {object} PublicViewer
 * @property {string} connection Connection, i.e. CMS tab.
 * @property {string} user_id User ID.
 * @property {string} name User’s name.
 */

/**
 * Outcome of a presence message: the entry whose viewers have changed and the client’s new list of
 * open entries, if anything changed, or an error.
 * @typedef {{ key?: string, open?: string[], error?: string }} PresenceResult
 */

/**
 * Handle a presence message from a client, if it is one:
 * - `{ type: 'open', key }` says the entry is open in the client’s editor, read-only or not;
 * - `{ type: 'close', key }` says it no longer is.
 *
 * Unlike a lock, anyone can open an entry, a viewer included, and any number of people at once.
 * @param {PresenceClient} client Client.
 * @param {string | ArrayBuffer} data Raw message.
 * @returns {PresenceResult | undefined} Outcome, or `undefined` if it’s not a presence message.
 */
export const handlePresenceMessage = (client, data) => {
  const { type, key } = parseSocketMessage(data);

  if (type !== 'open' && type !== 'close') {
    return undefined;
  }

  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) {
    return { error: 'invalid_message' };
  }

  const open = client.open ?? [];

  if (type === 'close') {
    if (!open.includes(key)) {
      return {};
    }

    return { key, open: open.filter((openKey) => openKey !== key) };
  }

  if (open.includes(key)) {
    return {};
  }

  const next = [...open, key];

  if (
    next.length > MAX_OPEN_ENTRIES ||
    new TextEncoder().encode(JSON.stringify({ ...client, open: next })).byteLength > MAX_CLIENT_SIZE
  ) {
    return { error: 'too_many_open' };
  }

  return { key, open: next };
};

/**
 * Describe a connection as someone with an entry open.
 * @param {PresenceClient} client Client.
 * @returns {PublicViewer} Viewer.
 */
const toViewer = ({ connection, userId, name }) => ({ connection, user_id: userId, name });

/**
 * List the people with an entry open, one per connection, as a person may have it open in several
 * tabs.
 * @param {PresenceClient[]} clients Every open connection.
 * @param {string} key Entry key.
 * @returns {PublicViewer[]} Viewers.
 */
export const listViewers = (clients, key) =>
  clients.filter(({ open }) => open?.includes(key)).map(toViewer);

/**
 * List the people with each entry open, for a new connection to start from.
 * @param {PresenceClient[]} clients Every open connection.
 * @returns {Record<string, PublicViewer[]>} Viewers by entry key, leaving out entries nobody has
 * open.
 */
export const listPresence = (clients) => {
  /**
   * Keys come from clients, so the map has no prototype whose properties, such as `constructor`,
   * a key could be mistaken for.
   * @type {Record<string, PublicViewer[]>}
   */
  const presence = Object.create(null);

  clients.forEach((client) => {
    client.open?.forEach((key) => {
      (presence[key] ??= []).push(toViewer(client));
    });
  });

  return presence;
};

/**
 * Record a tab’s heartbeat, with the entries it has open, where tabs send heartbeats instead of
 * keeping a connection open.
 * @param {Database} db Database.
 * @param {{ userId: string, name: string, role: string }} user User.
 * @param {unknown} connection Tab ID.
 * @param {unknown} open Keys of the open entries.
 * @param {number} [now] Current time.
 * @returns {Promise<string | undefined>} Error code, if the heartbeat is invalid.
 */
export const recordHeartbeat = async (
  db,
  { userId, name, role },
  connection,
  open,
  now = Date.now(),
) => {
  if (typeof connection !== 'string' || !CONNECTION_REGEX.test(connection)) {
    return 'invalid_connection';
  }

  if (
    !Array.isArray(open) ||
    open.length > MAX_OPEN_ENTRIES ||
    !open.every((key) => typeof key === 'string' && key && key.length <= MAX_KEY_LENGTH)
  ) {
    return 'invalid_message';
  }

  // A tab ID is the client’s own choice, and everyone can see it: one through which someone else
  // still holds locks, e.g. a tab closed within their grace period, can’t be taken over
  if (await hasOthersLocks(db, connection, userId)) {
    return 'invalid_connection';
  }

  const recorded = await putPresenceRow(db, {
    connection,
    user_id: userId,
    name,
    open: JSON.stringify([...new Set(open)]),
    seen_at: now,
  });

  // Someone else’s tab ID
  if (!recorded) {
    return 'invalid_connection';
  }

  // A tab back after a gap, e.g. a network outage, keeps its locks if their grace period has
  // started but isn’t over; not a viewer’s, e.g. someone demoted meanwhile, who can’t hold any
  if (role !== 'viewer') {
    await adoptLockRows(db, connection, userId);
  }

  return undefined;
};

/**
 * Check a tab ID is one of the user’s tabs that still sends heartbeats.
 * @param {Database} db Database.
 * @param {string} userId User ID.
 * @param {unknown} connection Tab ID.
 * @param {number} [now] Current time.
 * @returns {Promise<boolean>} Result.
 */
export const isLiveConnection = async (db, userId, connection, now = Date.now()) => {
  if (typeof connection !== 'string') {
    return false;
  }

  const row = await getPresenceRow(db, connection);

  return !!row && row.user_id === userId && row.seen_at >= now - HEARTBEAT_TTL;
};

/**
 * List the tabs that still send heartbeats, as clients, dropping those that have stopped.
 * @param {Database} db Database.
 * @param {number} [now] Current time.
 * @returns {Promise<PresenceClient[]>} Clients.
 */
export const listHeartbeatClients = async (db, now = Date.now()) => {
  await deleteStalePresenceRows(db, now - HEARTBEAT_TTL);

  return (await listPresenceRows(db, now - HEARTBEAT_TTL)).map((row) => ({
    connection: row.connection,
    userId: row.user_id,
    name: row.name,
    // Not kept with a heartbeat, nor needed to tell who has an entry open
    role: 'viewer',
    open: JSON.parse(row.open),
  }));
};
