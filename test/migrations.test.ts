import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, teardownTestDb } from './helpers.ts';
import { getDb, migrate } from '../src/db.ts';
import { migration001 } from '../src/migrations/001_init.ts';

describe('migrations', () => {
  it('are repeatable: running twice applies each migration exactly once', () => {
    setupTestDb('migrations');
    const db = getDb();
    migrate(db, [migration001]);
    migrate(db, [migration001]);
    const rows = db.prepare('SELECT * FROM schema_migrations').all();
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0]!.name), '001_init');
    teardownTestDb();
  });
});
