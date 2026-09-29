import type { DatabaseSync } from "node:sqlite";
import type { CreatedAnalysis } from "./analysis.ts";

/** Render a markdown report for an analysis (structured coverage check only). */
export function renderReport(db: DatabaseSync, res: CreatedAnalysis): string {
  const s = res.summary;
  const branches = db
    .prepare("SELECT * FROM analysis_branches WHERE analysis_id=? ORDER BY branch_no")
    .all(s.id) as { branch_no: number; root_claim_no: number; path: string; features: string; mutex_conflict: number; conflict_pair: string | null }[];
  const lines: string[] = [];
  lines.push(`# Structured Coverage Check Report`);
  lines.push(``);
  lines.push(`> This report is an automated **structured coverage check** only. It is not a legal opinion,`);
  lines.push(`> not a semantic similarity analysis, and never merges multiple documents into one.`);
  lines.push(``);
  lines.push(`- Analysis: \`${s.id}\``);
  lines.push(`- Application: \`${s.appId}\``);
  lines.push(`- Priority date: ${s.priorityDate} (same-day publications excluded)`);
  lines.push(`- Dictionary version: ${s.dictVersion}`);
  lines.push(`- Branches: ${s.branchCount}, documents in scope: ${s.docCount}, prior art: ${s.priorArtCount}`);
  lines.push(`- Result: **${s.novelty}**`);
  lines.push(``);
  lines.push(`## Branches`);
  for (const b of branches) {
    const conflict = b.mutex_conflict ? ` **MUTEX ${b.conflict_pair}**` : "";
    lines.push(`- #${b.branch_no} root=${b.root_claim_no} path=${b.path} features=${b.features}${conflict}`);
  }
  lines.push(``);
  lines.push(`## Coverage (one document per row, no cross-document stitching)`);
  for (const c of res.coverage) {
    lines.push(`### Branch #${c.branchNo} vs ${c.docNo} (priorArt=${c.isPriorArt}, covered=${c.covered})`);
    for (const item of c.items) {
      const via = item.matchedFeature && item.matchedFeature !== item.feature ? ` (equivalent: ${item.matchedFeature})` : "";
      const ev = item.evidence ? ` — ${item.evidence}` : "";
      lines.push(`- ${item.feature}: **${item.status}**${via}${ev}`);
    }
    if (c.missing.length) lines.push(`- MISSING: ${c.missing.join(", ")}`);
    lines.push(``);
  }
  if (res.reviewIssues.length) {
    lines.push(`## Pending Review`);
    for (const f of res.reviewIssues) lines.push(`- [${f.issueType}] ${f.subject}: ${f.detail}`);
  }
  return lines.join("\n") + "\n";
}
