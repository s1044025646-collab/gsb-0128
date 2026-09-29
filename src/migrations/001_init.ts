import type { Migration } from '../db.ts';

export const migration001: Migration = {
  id: 1,
  name: '001_init',
  sql: `
CREATE TABLE dictionary (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  version_label TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE feature (
  dictionary_id TEXT NOT NULL REFERENCES dictionary(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (dictionary_id, code)
);
CREATE TABLE equivalence (
  dictionary_id TEXT NOT NULL REFERENCES dictionary(id),
  code_a TEXT NOT NULL,
  code_b TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'equivalent',
  PRIMARY KEY (dictionary_id, code_a, code_b)
);
CREATE TABLE feature_mutex (
  dictionary_id TEXT NOT NULL REFERENCES dictionary(id),
  code_a TEXT NOT NULL,
  code_b TEXT NOT NULL,
  PRIMARY KEY (dictionary_id, code_a, code_b)
);

CREATE TABLE application (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  filing_date TEXT NOT NULL,
  priority_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE claim (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES application(id),
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  dependency_type TEXT NOT NULL,
  parent_numbers TEXT NOT NULL,
  features TEXT NOT NULL,
  optional INTEGER NOT NULL DEFAULT 0,
  UNIQUE (application_id, number)
);

CREATE TABLE reference (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  publication_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE reference_disclosure (
  reference_id TEXT NOT NULL REFERENCES reference(id),
  feature_code TEXT NOT NULL,
  PRIMARY KEY (reference_id, feature_code)
);

CREATE TABLE analysis_run (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  dictionary_id TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  scope TEXT NOT NULL,
  basis_snapshot TEXT NOT NULL,
  basis_hash TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE coverage_result (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES analysis_run(id),
  branch_index INTEGER NOT NULL,
  claim_number INTEGER NOT NULL,
  path TEXT NOT NULL,
  included_claims TEXT NOT NULL,
  branch_features TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  eligible INTEGER NOT NULL,
  eligibility_reason TEXT NOT NULL,
  feature_code TEXT NOT NULL,
  status TEXT NOT NULL,
  via TEXT,
  matched_code TEXT,
  note TEXT
);
CREATE TABLE branch_summary (
  run_id TEXT NOT NULL,
  branch_index INTEGER NOT NULL,
  claim_number INTEGER NOT NULL,
  reference_id TEXT NOT NULL,
  eligible INTEGER NOT NULL,
  fully_covered INTEGER NOT NULL,
  disclosed_count INTEGER NOT NULL,
  missing_count INTEGER NOT NULL,
  review_count INTEGER NOT NULL,
  unknown_count INTEGER NOT NULL,
  PRIMARY KEY (run_id, branch_index, reference_id)
);

CREATE TABLE review (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  branch_index INTEGER,
  reference_id TEXT,
  feature_code TEXT,
  conclusion TEXT NOT NULL,
  note TEXT,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, branch_index, reference_id, feature_code, reviewer)
);
`,
};
