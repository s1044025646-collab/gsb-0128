import { getDb } from '../db.ts';
import { AppError, ErrorCodes } from '../errors.ts';
import { nowIso } from '../clock.ts';
import { fail, isNonEmptyString, isObject } from '../validation.ts';
import { loadAnalysis } from './analysis.ts';

export const REVIEW_CONCLUSIONS = [
  'confirmed_disclosed',
  'confirmed_missing',
  'accepted_equivalence',
  'rejected_equivalence',
  'note',
] as const;

export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number];

export interface Review {
  id: string;
  run_id: string;
  branch_index: number | null;
  reference_id: string | null;
  feature_code: string | null;
  conclusion: ReviewConclusion;
  note: string | null;
  reviewer: string;
  created_at: string;
}

export interface ReviewInput {
  branch_index?: number | null;
  reference_id?: string | null;
  feature_code?: string | null;
  conclusion: string;
  note?: string;
  reviewer: string;
}

function rowToReview(row: Record<string, unknown>): Review {
  return {
    id: String(row.id),
    run_id: String(row.run_id),
    branch_index: row.branch_index == null ? null : Number(row.branch_index),
    reference_id: row.reference_id == null ? null : String(row.reference_id),
    feature_code: row.feature_code == null ? null : String(row.feature_code),
    conclusion: String(row.conclusion) as ReviewConclusion,
    note: row.note == null ? null : String(row.note),
    reviewer: String(row.reviewer),
    created_at: String(row.created_at),
  };
}

export function addReview(runId: string, input: unknown): Review {
  if (!isObject(input)) fail(ErrorCodes.VALIDATION_FAILED, 'review payload must be an object');
  const body = input as Record<string, unknown>;
  if (!isNonEmptyString(body.reviewer)) fail(ErrorCodes.VALIDATION_FAILED, 'reviewer is required', { field: 'reviewer' });
  if (!isNonEmptyString(body.conclusion) || !REVIEW_CONCLUSIONS.includes(body.conclusion as ReviewConclusion)) {
    fail(ErrorCodes.VALIDATION_FAILED, `conclusion must be one of ${REVIEW_CONCLUSIONS.join(', ')}`, { field: 'conclusion' });
  }
  const branchIndex = body.branch_index == null ? null : Number(body.branch_index);
  if (branchIndex != null && (!Number.isInteger(branchIndex) || branchIndex < 0)) {
    fail(ErrorCodes.VALIDATION_FAILED, 'branch_index must be a non-negative integer', { field: 'branch_index' });
  }
  const referenceId = body.reference_id == null ? null : String(body.reference_id);
  const featureCode = body.feature_code == null ? null : String(body.feature_code);

  // Validate against the frozen analysis result.
  const result = loadAnalysis(runId);
  if (branchIndex != null && !result.branches.some((b) => b.index === branchIndex)) {
    fail(ErrorCodes.VALIDATION_FAILED, `branch_index ${branchIndex} does not exist in analysis ${runId}`, { field: 'branch_index' });
  }
  if (referenceId != null && !result.references.some((r) => r.reference_id === referenceId)) {
    fail(ErrorCodes.VALIDATION_FAILED, `reference_id ${referenceId} is not part of analysis ${runId}`, { field: 'reference_id' });
  }
  if (branchIndex != null && featureCode != null) {
    const branch = result.branches.find((b) => b.index === branchIndex);
    if (branch && !branch.features.some((f) => f.code === featureCode)) {
      fail(ErrorCodes.VALIDATION_FAILED, `feature_code ${featureCode} is not in branch ${branchIndex}`, { field: 'feature_code' });
    }
  }

  const d = getDb();
  const id = `review-${runId}-${branchIndex ?? 'x'}-${referenceId ?? 'x'}-${featureCode ?? 'x'}-${String(body.reviewer).replace(/[^a-zA-Z0-9]/g, '_')}`;
  d.prepare(
    `INSERT INTO review (id, run_id, branch_index, reference_id, feature_code, conclusion, note, reviewer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, branch_index, reference_id, feature_code, reviewer) DO UPDATE SET
       conclusion = excluded.conclusion,
       note = excluded.note,
       created_at = excluded.created_at`,
  ).run(
    id,
    runId,
    branchIndex,
    referenceId,
    featureCode,
    body.conclusion,
    body.note == null ? null : String(body.note),
    String(body.reviewer),
    nowIso(),
  );
  const row = d.prepare('SELECT * FROM review WHERE id = ?').get(id);
  if (!row) throw new AppError(500, ErrorCodes.INTERNAL, 'failed to persist review');
  return rowToReview(row);
}

export function listReviews(runId: string): Review[] {
  return getDb()
    .prepare('SELECT * FROM review WHERE run_id = ? ORDER BY branch_index, reference_id, feature_code, reviewer')
    .all(runId)
    .map(rowToReview);
}
