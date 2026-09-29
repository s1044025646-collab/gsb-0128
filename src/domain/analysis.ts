import { createHash } from 'node:crypto';
import { getDb, tx } from '../db.ts';
import { AppError, ErrorCodes } from '../errors.ts';
import { now, nowIso } from '../clock.ts';
import { fail, isNonEmptyString, isObject } from '../validation.ts';
import { expandClaims, mutexKey, type Branch, type Finding } from './expansion.ts';
import { eligibilityReason, isPriorArt } from './dates.ts';
import { loadBundle as loadDictionary } from './dictionary.ts';
import { loadBundle as loadApplication } from './applications.ts';
import { listReferences, loadBundle as loadReference } from './references.ts';
import { getReferenceByExternalId } from './references.ts';
import type { ApplicationBundle, DictionaryBundle, ReferenceBundle } from './types.ts';

export type CellStatus = 'disclosed' | 'missing' | 'needs_review';

export interface CoverageCell {
  feature_code: string;
  status: CellStatus;
  via: 'direct' | 'equivalence' | null;
  matched_code: string | null;
  note: string | null;
}

export interface BranchReferenceResult {
  reference_id: string;
  external_id: string;
  title: string;
  publication_date: string;
  eligible: boolean;
  reason: string;
  unknown_count: number;
  unknown_disclosed_features: string[];
  branch_results: {
    branch_index: number;
    fully_covered: boolean;
    disclosed_count: number;
    missing_count: number;
    review_count: number;
    cells: CoverageCell[];
  }[];
}

export interface AnalysisRunRecord {
  id: string;
  application_id: string;
  dictionary_id: string;
  effective_date: string;
  scope: string;
  basis_snapshot: string;
  basis_hash: string;
  note: string | null;
  created_at: string;
}

export interface CreateAnalysisInput {
  application_id: string;
  dictionary_id: string;
  effective_date?: string;
  scope?: string[] | 'all';
  note?: string;
}

/** Accepts either an internal id (ref-xxx) or a user-facing external id. */
function resolveReferenceId(idOrExternalId: string): string {
  try {
    return loadReference(idOrExternalId).id;
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCodes.REFERENCE_NOT_FOUND) {
      return getReferenceByExternalId(idOrExternalId).id;
    }
    throw err;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function computeBasisHash(snapshot: unknown): string {
  return createHash('sha256').update(stableStringify(snapshot), 'utf8').digest('hex');
}

/**
 * Structured coverage check for one branch against one reference.
 * A reference can only disclose a feature directly or through an explicit
 * dictionary equivalence. Documents are never combined.
 */
export function computeCells(
  required: { code: string }[],
  disclosed: Set<string>,
  dictFeatureCodes: Set<string>,
  equivalences: { code_a: string; code_b: string; relation: string }[],
): { cells: CoverageCell[]; unknown: string[] } {
  const eq = new Map<string, { other: string; relation: string }[]>();
  for (const e of equivalences) {
    if (!eq.has(e.code_a)) eq.set(e.code_a, []);
    if (!eq.has(e.code_b)) eq.set(e.code_b, []);
    eq.get(e.code_a)!.push({ other: e.code_b, relation: e.relation });
    eq.get(e.code_b)!.push({ other: e.code_a, relation: e.relation });
  }
  const unknown = [...disclosed].filter((c) => !dictFeatureCodes.has(c)).sort();
  const cells: CoverageCell[] = required.map(({ code }) => {
    if (disclosed.has(code)) {
      return { feature_code: code, status: 'disclosed', via: 'direct', matched_code: code, note: null };
    }
    const rels = eq.get(code) ?? [];
    for (const r of rels) {
      if (r.relation === 'equivalent' && disclosed.has(r.other)) {
        return { feature_code: code, status: 'disclosed', via: 'equivalence', matched_code: r.other, note: null };
      }
    }
    for (const r of rels) {
      if (r.relation !== 'equivalent' && disclosed.has(r.other)) {
        return {
          feature_code: code,
          status: 'needs_review',
          via: 'equivalence',
          matched_code: r.other,
          note: `词典关系 ${r.relation} 未被确认为等价，待人工复核`,
        };
      }
    }
    if (unknown.length > 0) {
      return {
        feature_code: code,
        status: 'needs_review',
        via: null,
        matched_code: null,
        note: `文献披露了词典未收录的特征 ${unknown.join(', ')}，无法判断是否等价`,
      };
    }
    return { feature_code: code, status: 'missing', via: null, matched_code: null, note: null };
  });
  return { cells, unknown };
}

export function buildSnapshot(
  app: ApplicationBundle,
  dict: DictionaryBundle,
  refs: ReferenceBundle[],
  effectiveDate: string,
  scope: string[] | 'all',
): Record<string, unknown> {
  return {
    application: {
      id: app.id,
      external_id: app.external_id,
      title: app.title,
      filing_date: app.filing_date,
      priority_date: app.priority_date,
    },
    claims: app.claims.map((c) => ({
      number: c.number,
      type: c.type,
      dependency_type: c.dependency_type,
      parent_numbers: c.parent_numbers,
      features: c.features,
      optional: c.optional,
    })),
    dictionary: {
      id: dict.id,
      external_id: dict.external_id,
      version_label: dict.version_label,
      features: dict.features,
      equivalences: dict.equivalences,
      mutex: dict.mutex,
    },
    references: refs.map((r) => ({
      id: r.id,
      external_id: r.external_id,
      title: r.title,
      publication_date: r.publication_date,
      features: r.features,
    })),
    effective_date: effectiveDate,
    scope,
  };
}

export interface AnalysisResult {
  run: AnalysisRunRecord;
  branches: Branch[];
  references: BranchReferenceResult[];
  findings: Finding[];
}

export function createAnalysis(input: unknown): AnalysisResult {
  if (!isObject(input)) fail(ErrorCodes.VALIDATION_FAILED, 'analysis payload must be an object');
  const body = input as Record<string, unknown>;
  if (!isNonEmptyString(body.application_id)) fail(ErrorCodes.VALIDATION_FAILED, 'application_id is required', { field: 'application_id' });
  if (!isNonEmptyString(body.dictionary_id)) fail(ErrorCodes.VALIDATION_FAILED, 'dictionary_id is required', { field: 'dictionary_id' });

  const app = loadApplication(String(body.application_id));
  const dict = loadDictionary(String(body.dictionary_id));
  const effectiveDate =
    body.effective_date == null ? app.priority_date : (() => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.effective_date))) {
        fail(ErrorCodes.INVALID_DATE, 'effective_date must be YYYY-MM-DD', { field: 'effective_date' });
      }
      return String(body.effective_date);
    })();

  let scope: string[] | 'all' = 'all';
  if (body.scope != null) {
    if (body.scope !== 'all' && !Array.isArray(body.scope)) {
      fail(ErrorCodes.INVALID_SCOPE, 'scope must be "all" or an array of reference ids', { field: 'scope' });
    }
    if (Array.isArray(body.scope)) {
      scope = (body.scope as unknown[]).map((s) => resolveReferenceId(String(s)));
    }
  }

  const mutexPairs = new Set(dict.mutex.map((m) => mutexKey(m.code_a, m.code_b)));
  const { branches, findings } = expandClaims(app.claims, mutexPairs);
  const blocking = findings.filter((f) => f.type === 'cycle' || f.type === 'missing_citation');
  if (blocking.length > 0) {
    throw new AppError(409, ErrorCodes.ANALYSIS_BLOCKED, 'cannot run structured coverage check: claim graph has cycles or missing citations', {
      findings: blocking,
    });
  }

  const dictFeatureCodes = new Set(dict.features.map((f) => f.code));
  for (const b of branches) {
    for (const f of b.features) {
      if (!dictFeatureCodes.has(f.code)) {
        throw new AppError(422, ErrorCodes.UNKNOWN_CLAIM_FEATURE, `claim feature ${f.code} is not in dictionary ${dict.id}`, {
          feature: f.code,
          introduced_by: f.introduced_by,
        });
      }
    }
  }

  const allRefs = listReferences().map((r) => loadReference(r.id));
  const scopedRefs = scope === 'all' ? allRefs : allRefs.filter((r) => (scope as string[]).includes(r.id));
  const snapshot = buildSnapshot(app, dict, allRefs, effectiveDate, scope);
  const basisHash = computeBasisHash(snapshot);
  const runId = `analysis-${app.external_id}-${dict.external_id}-${now().getTime().toString(36)}`;

  const d = getDb();
  tx(() => {
    d.prepare(
      'INSERT INTO analysis_run (id, application_id, dictionary_id, effective_date, scope, basis_snapshot, basis_hash, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      runId,
      app.id,
      dict.id,
      effectiveDate,
      JSON.stringify(scope),
      JSON.stringify(snapshot),
      basisHash,
      body.note == null ? null : String(body.note),
      nowIso(),
    );

    const cellStmt = d.prepare(
      `INSERT INTO coverage_result
        (run_id, branch_index, claim_number, path, included_claims, branch_features, reference_id, eligible, eligibility_reason, feature_code, status, via, matched_code, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const summaryStmt = d.prepare(
      `INSERT INTO branch_summary
        (run_id, branch_index, claim_number, reference_id, eligible, fully_covered, disclosed_count, missing_count, review_count, unknown_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const ref of scopedRefs) {
      const eligible = isPriorArt(ref.publication_date, effectiveDate);
      const reason = eligibilityReason(ref.publication_date, effectiveDate);
      const disclosed = new Set(ref.features);
      for (const branch of branches) {
        const { cells, unknown } = computeCells(
          branch.features.map((f) => ({ code: f.code })),
          disclosed,
          dictFeatureCodes,
          dict.equivalences,
        );
        let disclosedCount = 0;
        let missingCount = 0;
        let reviewCount = 0;
        for (const cell of cells) {
          if (cell.status === 'disclosed') disclosedCount += 1;
          else if (cell.status === 'missing') missingCount += 1;
          else reviewCount += 1;
          cellStmt.run(
            runId,
            branch.index,
            branch.claim_number,
            JSON.stringify(branch.path),
            JSON.stringify(branch.included_claims),
            JSON.stringify(branch.features),
            ref.id,
            eligible ? 1 : 0,
            reason,
            cell.feature_code,
            cell.status,
            cell.via,
            cell.matched_code,
            cell.note,
          );
        }
        const fullyCovered = eligible && missingCount === 0 && reviewCount === 0;
        summaryStmt.run(
          runId,
          branch.index,
          branch.claim_number,
          ref.id,
          eligible ? 1 : 0,
          fullyCovered ? 1 : 0,
          disclosedCount,
          missingCount,
          reviewCount,
          unknown.length,
        );
      }
    }
  });

  return loadAnalysis(runId);
}

export function loadAnalysis(runId: string): AnalysisResult {
  const d = getDb();
  const runRow = d.prepare('SELECT * FROM analysis_run WHERE id = ?').get(runId);
  if (!runRow) throw new AppError(404, ErrorCodes.ANALYSIS_NOT_FOUND, `analysis ${runId} not found`);
  const run: AnalysisRunRecord = {
    id: String(runRow.id),
    application_id: String(runRow.application_id),
    dictionary_id: String(runRow.dictionary_id),
    effective_date: String(runRow.effective_date),
    scope: String(runRow.scope),
    basis_snapshot: String(runRow.basis_snapshot),
    basis_hash: String(runRow.basis_hash),
    note: runRow.note == null ? null : String(runRow.note),
    created_at: String(runRow.created_at),
  };

  const branchRows = d
    .prepare('SELECT DISTINCT branch_index, claim_number, path, included_claims, branch_features FROM coverage_result WHERE run_id = ? ORDER BY branch_index')
    .all(runId);
  const branches: Branch[] = branchRows.map((r) => ({
    index: Number(r.branch_index),
    claim_number: Number(r.claim_number),
    path: JSON.parse(String(r.path)) as number[],
    included_claims: JSON.parse(String(r.included_claims)) as number[],
    features: JSON.parse(String(r.branch_features)) as Branch['features'],
    issues: [],
  }));

  const summaryRows = d
    .prepare('SELECT * FROM branch_summary WHERE run_id = ? ORDER BY reference_id, branch_index')
    .all(runId);
  const refMap = new Map<string, BranchReferenceResult & { branchMap: Map<number, BranchReferenceResult['branch_results'][number]> }>();
  for (const s of summaryRows) {
    const refId = String(s.reference_id);
    if (!refMap.has(refId)) {
      const ref = loadReference(refId);
      refMap.set(refId, {
        reference_id: ref.id,
        external_id: ref.external_id,
        title: ref.title,
        publication_date: ref.publication_date,
        eligible: Number(s.eligible) === 1,
        reason: eligibilityReason(ref.publication_date, run.effective_date),
        unknown_count: 0,
        unknown_disclosed_features: [],
        branch_results: [],
        branchMap: new Map(),
      });
    }
    const rr = refMap.get(refId)!;
    const branchIndex = Number(s.branch_index);
    const cells = d
      .prepare('SELECT * FROM coverage_result WHERE run_id = ? AND branch_index = ? AND reference_id = ? ORDER BY feature_code')
      .all(runId, branchIndex, refId)
      .map((c) => ({
        feature_code: String(c.feature_code),
        status: String(c.status) as CellStatus,
        via: (c.via == null ? null : String(c.via)) as CoverageCell['via'],
        matched_code: c.matched_code == null ? null : String(c.matched_code),
        note: c.note == null ? null : String(c.note),
      }));
    rr.branchMap.set(branchIndex, {
      branch_index: branchIndex,
      fully_covered: Number(s.fully_covered) === 1,
      disclosed_count: Number(s.disclosed_count),
      missing_count: Number(s.missing_count),
      review_count: Number(s.review_count),
      cells,
    });
    rr.unknown_count = Number(s.unknown_count);
  }

  for (const rr of refMap.values()) {
    const ref = loadReference(rr.reference_id);
    const dict = loadDictionary(run.dictionary_id);
    const dictFeatureCodes = new Set(dict.features.map((f) => f.code));
    rr.unknown_disclosed_features = ref.features.filter((c) => !dictFeatureCodes.has(c)).sort();
    rr.branch_results = [...rr.branchMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, br]) => br);
  }

  return { run, branches, references: [...refMap.values()], findings: [] };
}

export function listAnalyses(): AnalysisRunRecord[] {
  return getDb()
    .prepare('SELECT * FROM analysis_run ORDER BY created_at, id')
    .all()
    .map((r) => ({
      id: String(r.id),
      application_id: String(r.application_id),
      dictionary_id: String(r.dictionary_id),
      effective_date: String(r.effective_date),
      scope: String(r.scope),
      basis_snapshot: String(r.basis_snapshot),
      basis_hash: String(r.basis_hash),
      note: r.note == null ? null : String(r.note),
      created_at: String(r.created_at),
    }));
}

/**
 * Recompute an analysis from its frozen snapshot and compare with the stored
 * results. Guarantees version reproduction: old analyses keep their basis.
 */
export function reproduceAnalysis(runId: string): {
  match: boolean;
  hash_match: boolean;
  results_match: boolean;
  stored_hash: string;
  computed_hash: string;
  differences: string[];
} {
  const stored = loadAnalysis(runId);
  const snapshot = JSON.parse(stored.run.basis_snapshot) as {
    claims: ApplicationBundle['claims'];
    dictionary: DictionaryBundle;
    references: ReferenceBundle[];
    effective_date: string;
  };
  const computedHash = computeBasisHash(snapshot);
  const hashMatch = computedHash === stored.run.basis_hash;

  const mutexPairs = new Set(snapshot.dictionary.mutex.map((m) => mutexKey(m.code_a, m.code_b)));
  const { branches } = expandClaims(snapshot.claims, mutexPairs);
  const dictFeatureCodes = new Set(snapshot.dictionary.features.map((f) => f.code));
  const differences: string[] = [];
  if (branches.length !== stored.branches.length) {
    differences.push(`branch count ${branches.length} != stored ${stored.branches.length}`);
  }
  for (let i = 0; i < Math.min(branches.length, stored.branches.length); i++) {
    const a = branches[i]!;
    const b = stored.branches[i]!;
    if (JSON.stringify(a.features.map((f) => f.code)) !== JSON.stringify(b.features.map((f) => f.code))) {
      differences.push(`branch ${i} feature set differs`);
    }
  }
  for (const rr of stored.references) {
    const ref = snapshot.references.find((r) => r.id === rr.reference_id);
    if (!ref) continue;
    const disclosed = new Set(ref.features);
    for (const branch of branches) {
      const { cells } = computeCells(
        branch.features.map((f) => ({ code: f.code })),
        disclosed,
        dictFeatureCodes,
        snapshot.dictionary.equivalences,
      );
      const storedCells = rr.branch_results.find((c) => c.branch_index === branch.index)?.cells ?? [];
      for (const cell of cells) {
        const sc = storedCells.find((c) => c.feature_code === cell.feature_code);
        if (!sc || sc.status !== cell.status || (cell.status === 'disclosed' && sc.matched_code !== cell.matched_code)) {
          differences.push(`branch ${branch.index} ref ${rr.reference_id} feature ${cell.feature_code}: ${sc?.status ?? 'missing'} -> ${cell.status}`);
        }
      }
    }
  }

  return {
    match: hashMatch && differences.length === 0,
    hash_match: hashMatch,
    results_match: differences.length === 0,
    stored_hash: stored.run.basis_hash,
    computed_hash: computedHash,
    differences,
  };
}
