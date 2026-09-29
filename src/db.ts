import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Central SQLite connection + idempotent migrations.
 *
 * The database path defaults to ./data/patent.sqlite inside the project and
 * can be overridden with PATENT_DB_PATH (tests use temp files). Migrations are
 * wrapped in a transaction and use IF NOT EXISTS / PRAGMA user_version so they
 * are safe to run repeatedly.
 */

export const DEFAULT_DB_PATH = resolve("data/patent.sqlite");

let currentDb: DatabaseSync | null = null;

export function openDb(path: string = process.env.PATENT_DB_PATH ?? DEFAULT_DB_PATH): DatabaseSync {
  const abs = isAbsolute(path) ? path : resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  const db = new DatabaseSync(abs);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  migrate(db);
  currentDb = db;
  return db;
}

export function getDb(): DatabaseSync {
  if (!currentDb) currentDb = openDb();
  return currentDb;
}

export function closeDb(db: DatabaseSync = getDb()): void {
  db.close();
  if (currentDb === db) currentDb = null;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    filing_date TEXT NOT NULL,
    priority_date TEXT,
    dict_version TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    claim_no INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('independent','dependent')),
    dep_type TEXT NOT NULL CHECK (dep_type IN ('none','any','all')),
    depends_on TEXT NOT NULL,
    features TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (app_id, claim_no)
  );

  CREATE TABLE IF NOT EXISTS dictionaries (
    version TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS dict_equivalences (
    version TEXT NOT NULL REFERENCES dictionaries(version) ON DELETE CASCADE,
    feature_a TEXT NOT NULL,
    feature_b TEXT NOT NULL,
    PRIMARY KEY (version, feature_a, feature_b)
  );

 CREATE TABLE IF NOT EXISTS mutex_constraints (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    feature_a TEXT NOT NULL,
    feature_b TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    doc_no TEXT NOT NULL,
    title TEXT NOT NULL,
    pub_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (doc_no)
  );

  CREATE TABLE IF NOT EXISTS document_disclosures (
    doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    feature TEXT NOT NULL,
    evidence TEXT NOT NULL,
    PRIMARY KEY (doc_id, feature)
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    priority_date TEXT NOT NULL,
    filing_date TEXT NOT NULL,
    dict_version TEXT NOT NULL,
    scope_doc_ids TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analysis_branches (
    id TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    branch_no INTEGER NOT NULL,
    root_claim_no INTEGER NOT NULL,
    path TEXT NOT NULL,
    features TEXT NOT NULL,
    mutex_conflict INTEGER NOT NULL DEFAULT 0,
    conflict_pair TEXT,
    UNIQUE (analysis_id, branch_no)
  );

  CREATE TABLE IF NOT EXISTS analysis_coverage (
    id TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE,
    branch_id TEXT NOT NULL REFERENCES analysis_branches(id) ON DELETE CASCADE,
    doc_id TEXT NOT NULL REFERENCES documents(id),
    in_scope INTEGER NOT NULL,
    is_prior_art INTEGER NOT NULL,
    covered INTEGER NOT NULL,
    items TEXT NOT NULL,
    missing TEXT NOT NULL,
    UNIQUE (branch_id, doc_id)
  );

  CREATE TABLE IF NOT EXISTS review_flags (
    id TEXT PRIMARY KEY,
    analysis_id TEXT REFERENCES analyses(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    issue_type TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','rejected')),
    conclusion TEXT,
    reviewer TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency (
    request_key TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_claims_app ON claims(app_id);
  CREATE INDEX IF NOT EXISTS idx_branches_analysis ON analysis_branches(analysis_id);
  CREATE INDEX IF NOT EXISTS idx_coverage_analysis ON analysis_coverage(analysis_id);
  CREATE INDEX IF NOT EXISTS idx_flags_analysis ON review_flags(analysis_id);
  `,
];

export function migrate(db: DatabaseSync = getDb()): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1};`);
    });
  }
}

/** Run fn inside BEGIN IMMEDIATE ... COMMIT, rolling back on any error. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Deterministic hex id, derived from content so repeats are idempotent. */
export function stableId(prefix: string, parts: (string | number)[]): string {
  let h1 = 0xdeadbeef ^ 0x9e3779b9;
  let h2 = 0x41c6ce57 ^ 0x9e3779b9;
  const str = parts.join("|");
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const a = (h2 >>> 0).toString(16).padStart(8, "0");
  const b = (h1 >>> 0).toString(16).padStart(8, "0");
  return `${prefix}_${a}${b}`;
}
