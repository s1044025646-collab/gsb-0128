import type { DatabaseSync } from "node:sqlite";
import { stableId, tx } from "./db.ts";
import { nowIso } from "./clock.ts";
import { AppError } from "./errors.ts";
import { expandClaims } from "./expand.ts";
import {
  getApplicationOrThrow,
  getClaims,
  rowToClaim,
  getMutexPairs,
  getEquivalenceMap,
  getDisclosures,
} from "./repository.ts";
import type { BranchCoverage, CoverageItem, ReviewIssue } from "./types.ts";

export interface AnalysisSummary {
  id: string;
  appId: string;
  priorityDate: string;
  dictVersion: string;
  status: string;
  branchCount: number;
  docCount: number;
  priorArtCount: number;
  novelty: "novel" | "anticipated" | "conflict_branches";
}

function docContentFingerprint(db: DatabaseSync, docId: string): string {
  const doc = db.prepare("SELECT doc_no, pub_date FROM documents WHERE id=?").get(docId) as
    | { doc_no: string; pub_date: string }
    | undefined;
  const disc = db
    .prepare("SELECT feature, evidence FROM document_disclosures WHERE doc_id=? ORDER BY feature")
    .all(docId) as { feature: string; evidence: string }[];
  return JSON.stringify({ doc, disc });
}

export function computeAnalysisId(
  db: DatabaseSync,
  appId: string,
  priorityDate: string,
  dictVersion: string,
  scopeDocIds: string[],
): string {
  const sorted = [...scopeDocIds].sort();
  const fps = sorted.map((id) => docContentFingerprint(db, id));
  const eqs = db
    .prepare("SELECT feature_a, feature_b FROM dict_equivalences WHERE version=? ORDER BY feature_a, feature_b")
    .all(dictVersion);
  return stableId("an", [appId, priorityDate, dictVersion, JSON.stringify(sorted), JSON.stringify(fps), JSON.stringify(eqs)]);
}

export interface CreatedAnalysis {
  summary: AnalysisSummary;
  coverage: BranchCoverage[];
  reviewIssues: ReviewIssue[];
  created: boolean;
}

/**
 * Create (or return the existing identical) structured-coverage analysis.
 * Analyses are immutable snapshots: changing claims, priority date, dictionary
 * or document contents yields a new id while prior analyses stay on record.
 */
export function createAnalysis(db: DatabaseSync, appId: string, scopeDocIds?: string[]): CreatedAnalysis {
  const app = getApplicationOrThrow(db, appId);
  const dict = db.prepare("SELECT version FROM dictionaries WHERE version=?").get(app.dict_version);
  if (!dict) throw new AppError("DICT_MISMATCH", `dictionary version ${app.dict_version} not imported`);

  let scope = scopeDocIds;
  if (!scope) {
    scope = (db.prepare("SELECT id FROM documents ORDER BY doc_no").all() as { id: string }[]).map((r) => r.id);
  } else {
    for (const id of scope) {
      if (!db.prepare("SELECT id FROM documents WHERE id=?").get(id)) {
        throw new AppError("NOT_FOUND", `scope document ${id} not found`);
      }
    }
  }
  const id = computeAnalysisId(db, appId, app.priority_date, app.dict_version, scope);
  const existing = db.prepare("SELECT id FROM analyses WHERE id=?").get(id);
  if (existing) {
    return loadAnalysis(db, id);
  }

  const claims = getClaims(db, appId).map(rowToClaim);
  const mutexPairs = getMutexPairs(db, appId);
  const { branches, issues } = expandClaims(claims, mutexPairs);
  if (issues.some((i) => i.code === "CYCLIC_REF" || i.code === "MISSING_REF")) {
    throw new AppError("CYCLIC_REF", "cannot analyze: citation errors present", issues);
  }
  const eqMap = getEquivalenceMap(db, app.dict_version);
  const ts = nowIso();

  const docs = scope.map((docId) => {
    const row = db.prepare("SELECT id, doc_no, pub_date FROM documents WHERE id=?").get(docId) as {
      id: string;
      doc_no: string;
      pub_date: string;
    };
    return { ...row, disclosures: getDisclosures(db, docId) };
  });

  const coverage: BranchCoverage[] = [];
  const reviewIssues: ReviewIssue[] = [];
  const flaggedUnknown = new Set<string>();
  const directlyDisclosed = new Set<string>();
  for (const doc of docs) for (const feature of doc.disclosures.keys()) directlyDisclosed.add(feature);

  for (const branch of branches) {
    for (const doc of docs) {
      const inScope = true;
      // Prior art requires STRICTLY earlier publication; same-day is excluded.
      const isPriorArt = doc.pub_date < app.priority_date;
      const items: CoverageItem[] = [];
      const missing: string[] = [];
      for (const feature of branch.features) {
        const direct = doc.disclosures.get(feature);
        if (direct !== undefined) {
          items.push({ feature, status: "disclosed", evidence: direct, matchedFeature: feature });
          continue;
        }
        let foundEquiv: { matched: string; evidence: string } | null = null;
        if (isPriorArt) {
          for (const equivalent of eqMap.get(feature) ?? []) {
            const ev = doc.disclosures.get(equivalent);
            if (ev !== undefined) {
              foundEquiv = { matched: equivalent, evidence: ev };
              break;
            }
          }
        }
        if (foundEquiv) {
          items.push({
            feature,
            status: "equivalent",
            evidence: foundEquiv.evidence,
            matchedFeature: foundEquiv.matched,
          });
        } else {
          items.push({ feature, status: "missing", evidence: null, matchedFeature: null });
          missing.push(feature);
          // equivalence only from the versioned dictionary; when the feature is
          // never disclosed directly anywhere and the dictionary has no
          // relationship for it, flag for review instead of guessing meaning
          if (!eqMap.has(feature) && !directlyDisclosed.has(feature) && !flaggedUnknown.has(feature)) {
            flaggedUnknown.add(feature);
            reviewIssues.push({
              subject: feature,
              issueType: "UNKNOWN_FEATURE",
              detail: `feature "${feature}" has no equivalence entry in dictionary ${app.dict_version}; do not infer meaning`,
            });
          }
        }
      }
      const covered = isPriorArt && missing.length === 0;
      coverage.push({
        branchNo: branch.branchNo,
        docId: doc.id,
        docNo: doc.doc_no,
        inScope,
        isPriorArt,
        covered,
        items,
        missing,
      });
    }
    if (branch.mutexConflict && branch.conflictPair) {
      reviewIssues.push({
        subject: `branch ${branch.branchNo}`,
        issueType: "MUTEX_CONFLICT",
        detail: `branch combines mutually exclusive features ${branch.conflictPair[0]} / ${branch.conflictPair[1]}`,
      });
    }
  }

  const anticipated = coverage.some((c) => c.covered);
  const status = "complete";

  tx(db, () => {
    db.prepare(
      `INSERT INTO analyses(id,app_id,priority_date,filing_date,dict_version,scope_doc_ids,status,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
    ).run(id, appId, app.priority_date, app.filing_date, app.dict_version, JSON.stringify(scope), status, ts);
    const insBranch = db.prepare(
      `INSERT INTO analysis_branches(id,analysis_id,branch_no,root_claim_no,path,features,mutex_conflict,conflict_pair)
       VALUES(?,?,?,?,?,?,?,?)`,
    );
    const insCov = db.prepare(
      `INSERT INTO analysis_coverage(id,analysis_id,branch_id,doc_id,in_scope,is_prior_art,covered,items,missing)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    );
    const insFlag = db.prepare(
      `INSERT INTO review_flags(id,analysis_id,subject,issue_type,detail,status,created_at)
       VALUES(?,?,?,?,?,?,?)`,
    );
    const branchIds = new Map<number, string>();
    for (const b of branches) {
      const bid = stableId("br", [id, b.branchNo]);
      branchIds.set(b.branchNo, bid);
      insBranch.run(
        bid,
        id,
        b.branchNo,
        b.rootClaimNo,
        JSON.stringify(b.path),
        JSON.stringify(b.features),
        b.mutexConflict ? 1 : 0,
        b.conflictPair ? JSON.stringify(b.conflictPair) : null,
      );
    }
    for (const c of coverage) {
      insCov.run(
        stableId("cov", [id, c.branchNo, c.docId]),
        id,
        branchIds.get(c.branchNo)!,
        c.docId,
        c.inScope ? 1 : 0,
        c.isPriorArt ? 1 : 0,
        c.covered ? 1 : 0,
        JSON.stringify(c.items),
        JSON.stringify(c.missing),
      );
    }
    for (const f of reviewIssues) {
      insFlag.run(stableId("fl", [id, f.subject, f.issueType]), id, f.subject, f.issueType, f.detail, "pending", ts);
    }
  });

  return loadAnalysis(db, id);
}

export function loadAnalysis(db: DatabaseSync, id: string): CreatedAnalysis {
  const a = db.prepare("SELECT * FROM analyses WHERE id=?").get(id) as
    | {
        id: string;
        app_id: string;
        priority_date: string;
        filing_date: string;
        dict_version: string;
        status: string;
      }
    | undefined;
  if (!a) throw new AppError("NOT_FOUND", `analysis ${id} not found`);
  const scope = JSON.parse(
    (db.prepare("SELECT scope_doc_ids FROM analyses WHERE id=?").get(id) as { scope_doc_ids: string }).scope_doc_ids,
  ) as string[];
  const branches = db.prepare("SELECT COUNT(*) n FROM analysis_branches WHERE analysis_id=?").get(id) as { n: number };
  const covRows = db.prepare("SELECT * FROM analysis_coverage WHERE analysis_id=?").all(id) as {
    branch_id: string;
    doc_id: string;
    in_scope: number;
    is_prior_art: number;
    covered: number;
    items: string;
    missing: string;
  }[];
  const docNos = new Map<string, string>();
  for (const docId of new Set(covRows.map((r) => r.doc_id))) {
    const d = db.prepare("SELECT doc_no FROM documents WHERE id=?").get(docId) as { doc_no: string };
    docNos.set(docId, d.doc_no);
  }
  const branchNoById = new Map<string, number>();
  const brRows = db.prepare("SELECT id, branch_no FROM analysis_branches WHERE analysis_id=?").all(id) as {
    id: string;
    branch_no: number;
  }[];
  for (const b of brRows) branchNoById.set(b.id, b.branch_no);
  const coverage: BranchCoverage[] = covRows.map((r) => ({
    branchNo: branchNoById.get(r.branch_id)!,
    docId: r.doc_id,
    docNo: docNos.get(r.doc_id)!,
    inScope: !!r.in_scope,
    isPriorArt: !!r.is_prior_art,
    covered: !!r.covered,
    items: JSON.parse(r.items),
    missing: JSON.parse(r.missing),
  }));
  const flags = db.prepare("SELECT * FROM review_flags WHERE analysis_id=?").all(id) as {
    subject: string;
    issue_type: string;
    detail: string;
  }[];
  const priorArtCount = new Set(covRows.filter((r) => r.is_prior_art).map((r) => r.doc_id)).size;
  const anticipated = coverage.some((c) => c.covered);
  const conflict = flags.some((f) => f.issue_type === "MUTEX_CONFLICT");
  const summary: AnalysisSummary = {
    id,
    appId: a.app_id,
    priorityDate: a.priority_date,
    dictVersion: a.dict_version,
    status: a.status,
    branchCount: branches.n,
    docCount: scope.length,
    priorArtCount,
    novelty: anticipated ? "anticipated" : conflict ? "conflict_branches" : "novel",
  };
  return {
    summary,
    coverage,
    reviewIssues: flags.map((f) => ({ subject: f.subject, issueType: f.issue_type, detail: f.detail })),
    created: false,
  };
}

export function listAnalyses(db: DatabaseSync, appId?: string): AnalysisSummary[] {
  const rows = appId
    ? (db.prepare("SELECT id FROM analyses WHERE app_id=? ORDER BY created_at").all(appId) as { id: string }[])
    : (db.prepare("SELECT id FROM analyses ORDER BY created_at").all() as { id: string }[]);
  return rows.map((r) => loadAnalysis(db, r.id).summary);
}

/** Manual review of a flagged issue. */
export function reviewFlag(
  db: DatabaseSync,
  flagId: string,
  conclusion: "confirmed" | "rejected",
  reviewer: string,
  note?: string,
): void {
  const row = db.prepare("SELECT id FROM review_flags WHERE id=?").get(flagId);
  if (!row) throw new AppError("NOT_FOUND", `review flag ${flagId} not found`);
  db.prepare("UPDATE review_flags SET status=?, conclusion=?, reviewer=?, reviewed_at=? WHERE id=?").run(
    conclusion,
    note ?? null,
    reviewer,
    nowIso(),
    flagId,
  );
}

export function listFlags(db: DatabaseSync, analysisId?: string, statusFilter?: string) {
  let sql = "SELECT * FROM review_flags";
  const where: string[] = [];
  const params: string[] = [];
  if (analysisId) {
    where.push("analysis_id = ?");
    params.push(analysisId);
  }
  if (statusFilter) {
    where.push("status = ?");
    params.push(statusFilter);
  }
  if (where.length) sql += " WHERE " + where.join(" AND ");
  sql += " ORDER BY created_at";
  return db.prepare(sql).all(...params);
}
