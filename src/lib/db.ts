import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
const locations = new WeakMap<Client, string>();
export function connect(
  url = process.env.DATABASE_URL || "file:.data/event-gate.db",
) {
  if (process.env.VERCEL && url.startsWith("file:"))
    throw new Error("Cloud deployment requires a remote DATABASE_URL");
  if (url.startsWith("file:.data/")) mkdirSync(".data", { recursive: true });
  const client = createClient({
    url,
    authToken: process.env.DATABASE_AUTH_TOKEN,
  });
  locations.set(client, url);
  return client;
}
let singleton: Client;
export function db() {
  return (singleton ||= connect());
}
// SQLite/libSQL serialize writers. Retry only lock acquisition, never a transaction
// body or a commit whose outcome might already have reached the database.
export async function writeTransaction(client: Client) {
  const url = locations.get(client);
  for (let attempt = 0; ; attempt++) {
    // A failed local BEGIN can leave a native prepared statement busy. A fresh
    // connection per attempt avoids returning that connection to the pool.
    const lease = url?.startsWith("file:") ? connect(url) : null;
    try {
      const tx = await (lease || client).transaction("write");
      if (lease) {
        const close = tx.close.bind(tx);
        tx.close = () => {
          close();
          lease.close();
        };
      }
      return tx;
    } catch (e) {
      lease?.close();
      if (
        attempt >= 30 ||
        !e ||
        typeof e !== "object" ||
        !("code" in e) ||
        e.code !== "SQLITE_BUSY"
      )
        throw e;
      await new Promise((resolve) =>
        setTimeout(resolve, 25 + Math.random() * 75),
      );
    }
  }
}
export async function initialize(client = db()) {
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','supervisor','checkin')),
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, starts_at TEXT NOT NULL, venue TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 100000),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id), name TEXT NOT NULL, email TEXT,
      category TEXT NOT NULL CHECK(category IN ('staff','performer','general')),
      token_hash TEXT NOT NULL UNIQUE, credential TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
      checked_in_at TEXT, created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS tickets_event ON tickets(event_id);
    CREATE TABLE IF NOT EXISTS checkins (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), user_id TEXT NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK(kind IN ('entry','reentry')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS first_entry ON checkins(ticket_id) WHERE kind='entry';
    CREATE TABLE IF NOT EXISTS reentry_requests (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), requested_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      resolved_by TEXT REFERENCES users(id), reason TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      resolved_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pending_reentry ON reentry_requests(ticket_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS email_deliveries (
      id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id), user_id TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL, provider_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}
