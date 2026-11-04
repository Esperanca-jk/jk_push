import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDatabase(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL,
      credentials TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      installation_id TEXT NOT NULL, user_id TEXT NOT NULL, platform TEXT NOT NULL,
      token_cipher TEXT NOT NULL, token_hash TEXT NOT NULL,
      environment TEXT NOT NULL DEFAULT 'production', locale TEXT,
      enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
      UNIQUE(project_id, installation_id)
    );
    CREATE INDEX IF NOT EXISTS devices_target_idx ON devices(project_id, enabled, user_id);
    CREATE TABLE IF NOT EXISTS topics (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      installation_id TEXT NOT NULL, topic TEXT NOT NULL,
      PRIMARY KEY(project_id, installation_id, topic),
      FOREIGN KEY(project_id, installation_id) REFERENCES devices(project_id, installation_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS topics_target_idx ON topics(project_id, topic);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, body TEXT NOT NULL, data_json TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      idempotency_key TEXT, request_hash TEXT,
      UNIQUE(project_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS messages_recent_idx ON messages(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL, last_error TEXT, provider_id TEXT,
      UNIQUE(message_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS deliveries_due_idx ON deliveries(status, next_attempt);
  `);
  return db;
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
