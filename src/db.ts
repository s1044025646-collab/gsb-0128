import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso } from './clock.ts';

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

let db: DatabaseSync | null = null;

export function openDb(filePath: string): DatabaseSync {
  mkdirSync(dirname(filePath), { recursive: true });
  const d = new DatabaseSync(filePath);
  d.exec('PRAGMA journal_mode = WAL;');
  d.exec('PRAGMA foreign_keys = ON;');
  db = d;
  return d;
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('database is not open');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/** Run `fn` inside a transaction; roll back on any error. */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Apply every pending migration. Repeatable: already-applied migrations are
 * skipped, so running it twice (or on every startup) is a no-op.
 */
export function migrate(d: DatabaseSync, migrations: Migration[]): void {
  d.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    d.prepare('SELECT name FROM schema_migrations').all().map((r) => String(r.name)),
  );
  for (const m of migrations) {
    if (applied.has(m.name)) continue;
    d.exec('BEGIN');
    try {
      d.exec(m.sql);
      d.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(
        m.id,
        m.name,
        nowIso(),
      );
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw err;
    }
  }
}
