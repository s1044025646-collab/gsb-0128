import { loadAnalysis } from './analysis.ts';
import { listReviews } from './reviews.ts';
import { getApplication } from './applications.ts';
import { getDictionary } from './dictionary.ts';

/**
 * Exportable JSON report. The automated result is always labeled
 * "structured coverage check"; manual reviews are listed separately.
 */
export function buildReport(runId: string): Record<string, unknown> {
  const result = loadAnalysis(runId);
  const app = getApplication(result.run.application_id);
  const dict = getDictionary(result.run.dictionary_id);
  const reviews = listReviews(runId);

  const matrix = result.references.map((ref) => ({
    reference_id: ref.reference_id,
    external_id: ref.external_id,
    title: ref.title,
    publication_date: ref.publication_date,
    eligible: ref.eligible,
    reason: ref.reason,
    branch_results: result.branches.map((branch) => {
      const entry = ref.branch_results.find((c) => c.branch_index === branch.index);
      return {
        branch_index: branch.index,
        claim_number: branch.claim_number,
        path: branch.path,
        included_claims: branch.included_claims,
        features: branch.features,
        fully_covered: entry?.fully_covered ?? false,
        disclosed_count: entry?.disclosed_count ?? 0,
        missing_count: entry?.missing_count ?? 0,
        review_count: entry?.review_count ?? 0,
        cells: entry ? entry.cells : [],
      };
    }),
  }));

  return {
    report_type: 'structured_coverage_check',
    analysis: {
      id: result.run.id,
      application_id: result.run.application_id,
      dictionary_id: result.run.dictionary_id,
      effective_date: result.run.effective_date,
      scope: result.run.scope,
      basis_hash: result.run.basis_hash,
      note: result.run.note,
      created_at: result.run.created_at,
    },
    application: {
      id: app.id,
      external_id: app.external_id,
      title: app.title,
      filing_date: app.filing_date,
      priority_date: app.priority_date,
    },
    dictionary: {
      id: dict.id,
      external_id: dict.external_id,
      version_label: dict.version_label,
    },
    branches: result.branches.map((b) => ({
      index: b.index,
      claim_number: b.claim_number,
      path: b.path,
      included_claims: b.included_claims,
      features: b.features,
    })),
    references: result.references.map((r) => ({
      reference_id: r.reference_id,
      external_id: r.external_id,
      title: r.title,
      publication_date: r.publication_date,
      eligible: r.eligible,
      reason: r.reason,
      unknown_count: r.unknown_count,
      unknown_disclosed_features: r.unknown_disclosed_features,
      any_branch_fully_covered: r.branch_results.some((b) => b.fully_covered),
    })),
    matrix,
    reviews,
    review_summary: {
      total: reviews.length,
      by_conclusion: reviews.reduce<Record<string, number>>((acc, r) => {
        acc[r.conclusion] = (acc[r.conclusion] ?? 0) + 1;
        return acc;
      }, {}),
    },
  };
}
