import type { DatabaseSync } from "node:sqlite";
import { stableId, tx } from "./db.ts";
import { nowIso } from "./clock.ts";
import { AppError } from "./errors.ts";
import type { ApplicationInput, DocumentInput } from "./types.ts";

interface ApplicationRow {
  id: string;
  title: string;
  filing_date: string;
  priority_date: string;
  dict_version: string;
}
interface ClaimRow {
  id: string;
  app_id: string;
  claim_no: number;
  kind: "independent" | "dependent";
  dep_type: "none" | "any" | "all";
  depends_on: string;
  features: string;
  seq: number;
}

export function applicationId(input: ApplicationInput): string {
  return stableId("app", [
    input.title,
    input.filingDate,
    input.priorityDate ?? input.filingDate,
    input.dictVersion,
    JSON.stringify(input.claims),
    JSON.stringify(input.mutexPairs ?? []),
  ]);
}

export function documentId(input: DocumentInput): string {
  return stableId("doc", [input.docNo]);
}

export function importDictionary(
  db: DatabaseSync,
  version: string,
  equivalences: [string, string][],
): { created: boolean } {
  const ts = nowIso();
  let created = false;
  tx(db, () => {
    const existing = db.prepare("SELECT version FROM dictionaries WHERE version = ?").get(version);
    if (!existing) {
      db.prepare("INSERT INTO dictionaries(version, created_at) VALUES(?,?)").run(version, ts);
      created = true;
    }
    const ins = db.prepare(
      "INSERT OR IGNORE INTO dict_equivalences(version, feature_a, feature_b) VALUES(?,?,?)",
    );
    for (const [a, b] of equivalences) {
      ins.run(version, a < b ? a : b, a < b ? b : a);
    }
  });
  return { created };
}

/**
 * Idempotent application import. The id is derived from the full content
 * (claims, dates, dictionary version, mutex constraints), so editing any of
 * those produces a new application/analysis while the old one is retained.
 */
export function importApplication(db: DatabaseSync, input: ApplicationInput): { id: string; created: boolean } {
  const id = input.id ?? applicationId(input);
  const ts = nowIso();
  let created = false;
  tx(db, () => {
    const existing = db.prepare("SELECT id FROM applications WHERE id = ?").get(id) as
      | { id: string }
      | undefined;
    if (existing) return;
    // Same natural key supplied explicitly but different content:
    if (input.id) {
      const sameNatural = db.prepare("SELECT id FROM applications WHERE id = ?").get(input.id);
      if (sameNatural) return;
    }
    db.prepare(
      "INSERT INTO applications(id,title,filing_date,priority_date,dict_version,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, input.title, input.filingDate, input.priorityDate ?? input.filingDate, input.dictVersion, ts);
    const insClaim = db.prepare(
      `INSERT INTO claims(id,app_id,claim_no,kind,dep_type,depends_on,features,seq,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    input.claims.forEach((c, i) => {
      insClaim.run(
        stableId("clm", [id, c.claimNo]),
        id,
        c.claimNo,
        c.kind,
        c.depType,
        JSON.stringify(c.dependsOn),
        JSON.stringify(c.features),
        i,
        ts,
      );
    });
    const insMutex = db.prepare(
      "INSERT INTO mutex_constraints(id,app_id,feature_a,feature_b,created_at) VALUES(?,?,?,?,?)",
    );
    for (const [a, b] of input.mutexPairs ?? []) {
      insMutex.run(stableId("mtx", [id, a, b]), id, a, b, ts);
    }
    created = true;
  });
  return { id, created };
}

/** Idempotent upsert by docNo; new analysis runs pick up changed disclosures. */
export function importDocument(db: DatabaseSync, input: DocumentInput): { id: string; created: boolean } {
  const id = input.id ?? documentId(input);
  const ts = nowIso();
  let created = false;
  tx(db, () => {
    const existing = db.prepare("SELECT id FROM documents WHERE id = ?").get(id);
    if (!existing) {
      db.prepare("INSERT INTO documents(id,doc_no,title,pub_date,created_at) VALUES(?,?,?,?,?)").run(
        id,
        input.docNo,
        input.title,
        input.pubDate,
        ts,
      );
      created = true;
    } else {
      db.prepare("UPDATE documents SET title=?, pub_date=? WHERE id=?").run(input.title, input.pubDate, id);
      db.prepare("DELETE FROM document_disclosures WHERE doc_id=?").run(id);
    }
    const ins = db.prepare(
      "INSERT INTO document_disclosures(doc_id,feature,evidence) VALUES(?,?,?)",
    );
    for (const d of input.disclosures) ins.run(id, d.feature, d.evidence);
  });
  return { id, created };
}

export function getApplicationOrThrow(db: DatabaseSync, id: string): ApplicationRow {
  const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as ApplicationRow | undefined;
  if (!row) throw new AppError("NOT_FOUND", `application ${id} not found`);
  return row;
}

export function getClaims(db: DatabaseSync, appId: string): ClaimRow[] {
  const rows = db.prepare("SELECT * FROM claims WHERE app_id=? ORDER BY claim_no").all(appId) as unknown as ClaimRow[];
  return rows.map((r) => ({ ...r }));
}

export function rowToClaim(r: ClaimRow) {
  return {
    claimNo: r.claim_no,
    kind: r.kind,
    depType: r.dep_type,
    dependsOn: JSON.parse(r.depends_on) as number[],
    features: JSON.parse(r.features) as string[],
  };
}

export function getMutexPairs(db: DatabaseSync, appId: string): [string, string][] {
  const rows = db.prepare("SELECT feature_a, feature_b FROM mutex_constraints WHERE app_id=?").all(appId) as
    | { feature_a: string; feature_b: string }[];
  return rows.map((r) => [r.feature_a, r.feature_b]);
}

export function getDocumentOrThrow(db: DatabaseSync, id: string) {
  const row = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  if (!row) throw new AppError("NOT_FOUND", `document ${id} not found`);
  return row as { id: string; doc_no: string; title: string; pub_date: string };
}

export function getDisclosures(
  db: DatabaseSync,
  docId: string,
): Map<string, string> {
  const rows = db.prepare("SELECT feature, evidence FROM document_disclosures WHERE doc_id=?").all(docId) as
    | { feature: string; evidence: string }[];
  return new Map(rows.map((r) => [r.feature, r.evidence]));
}

export function getEquivalenceMap(db: DatabaseSync, version: string): Map<string, Set<string>> {
  const rows = db.prepare(
    "SELECT feature_a, feature_b FROM dict_equivalences WHERE version=?",
  ).all(version) as { feature_a: string; feature_b: string }[];
  const map = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    let s = map.get(a);
    if (!s) {
      s = new Set();
      map.set(a, s);
    }
    s.add(b);
  };
  for (const r of rows) {
    add(r.feature_a, r.feature_b);
    add(r.feature_b, r.feature_a);
  }
  return map;
}
