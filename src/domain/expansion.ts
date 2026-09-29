import type { Claim } from './types.ts';

export interface ExpandedFeature {
  code: string;
  introduced_by: number;
}

export interface BranchIssue {
  type: 'mutex' | 'depends_on_cycle';
  feature_a?: string;
  feature_b?: string;
  claim_a?: number;
  claim_b?: number;
  detail?: string;
}

export interface Branch {
  claim_number: number;
  index: number;
  path: number[];
  included_claims: number[];
  features: ExpandedFeature[];
  issues: BranchIssue[];
}

export interface CycleFinding {
  type: 'cycle';
  claims: number[];
}

export interface MissingCitationFinding {
  type: 'missing_citation';
  claim: number;
  missing_parent: number;
}

export type Finding = CycleFinding | MissingCitationFinding;

export interface ExpansionResult {
  branches: Branch[];
  findings: Finding[];
}

export function mutexKey(a: string, b: string): string {
  return a < b ? `${a}<>${b}` : `${b}<>${a}`;
}

function combineFeatures(parent: ExpandedFeature[], own: string[], ownClaim: number): ExpandedFeature[] {
  const seen = new Set(parent.map((f) => f.code));
  const out = [...parent];
  for (const code of own) {
    if (!seen.has(code)) {
      seen.add(code);
      out.push({ code, introduced_by: ownClaim });
    }
  }
  return out;
}

function combine(parent: Branch, claim: Claim): Branch {
  return {
    claim_number: claim.number,
    index: -1,
    path: [...parent.path, claim.number],
    included_claims: [...parent.included_claims, claim.number],
    features: combineFeatures(parent.features, claim.features, claim.number),
    issues: [],
  };
}

function mergeBranches(parents: Branch[], claim: Claim): Branch {
  const path: number[] = [];
  const included: number[] = [];
  const seenPath = new Set<number>();
  for (const p of parents) {
    for (const n of [...p.path, ...p.included_claims]) {
      if (!seenPath.has(n)) {
        seenPath.add(n);
        path.push(n);
        included.push(n);
      }
    }
  }
  path.push(claim.number);
  included.push(claim.number);
  const features: ExpandedFeature[] = [];
  const seenFeat = new Set<string>();
  for (const p of parents) {
    for (const f of p.features) {
      if (!seenFeat.has(f.code)) {
        seenFeat.add(f.code);
        features.push(f);
      }
    }
  }
  for (const code of claim.features) {
    if (!seenFeat.has(code)) {
      seenFeat.add(code);
      features.push({ code, introduced_by: claim.number });
    }
  }
  return { claim_number: claim.number, index: -1, path, included_claims: included, features, issues: [] };
}

/**
 * Expand every claim into concrete feature branches.
 *
 * - single dependency: one branch per parent branch, own features appended
 * - multiple alternative (择一引用): one branch per parent alternative
 * - multiple simultaneous (同时引用): one branch merging all parents
 *
 * Cycles and missing citations are reported as findings instead of throwing,
 * so callers can surface them to the user.
 */
export function expandClaims(claims: Claim[], mutexPairs: Set<string>): ExpansionResult {
  const byNumber = new Map<number, Claim>();
  for (const c of claims) byNumber.set(c.number, c);

  const findings: Finding[] = [];
  const findingKeys = new Set<string>();
  const memo = new Map<number, Branch[]>();

  const addFinding = (f: Finding): void => {
    const key = f.type === 'cycle' ? `cycle:${f.claims.join('-')}` : `missing:${f.claim}->${f.missing_parent}`;
    if (!findingKeys.has(key)) {
      findingKeys.add(key);
      findings.push(f);
    }
  };

  const checkMutex = (branch: Branch): Branch => {
    const issues: BranchIssue[] = [];
    for (let i = 0; i < branch.features.length; i++) {
      for (let j = i + 1; j < branch.features.length; j++) {
        const a = branch.features[i]!;
        const b = branch.features[j]!;
        if (mutexPairs.has(mutexKey(a.code, b.code))) {
          issues.push({
            type: 'mutex',
            feature_a: a.code,
            feature_b: b.code,
            claim_a: a.introduced_by,
            claim_b: b.introduced_by,
          });
        }
      }
    }
    return { ...branch, issues };
  };

  function expand(n: number, stack: number[]): Branch[] {
    if (memo.has(n)) return memo.get(n)!;
    if (stack.includes(n)) {
      const start = stack.indexOf(n);
      addFinding({ type: 'cycle', claims: [...stack.slice(start), n] });
      return [];
    }
    const claim = byNumber.get(n);
    if (!claim) return [];

    const parents = claim.parent_numbers ?? [];
    for (const p of parents) {
      if (!byNumber.has(p)) addFinding({ type: 'missing_citation', claim: n, missing_parent: p });
    }
    const knownParents = parents.filter((p) => byNumber.has(p));

    let raw: Branch[];
    if (claim.type === 'independent' || knownParents.length === 0) {
      raw = [
        {
          claim_number: n,
          index: -1,
          path: [n],
          included_claims: [n],
          features: claim.features.map((code) => ({ code, introduced_by: n })),
          issues: [],
        },
      ];
    } else if (claim.dependency_type === 'multiple_simultaneous') {
      const parentBranches: Branch[] = [];
      let blockedByCycle = false;
      for (const p of knownParents) {
        const pb = expand(p, [...stack, n]);
        if (pb.length === 0) blockedByCycle = true;
        parentBranches.push(...pb);
      }
      if (parentBranches.length === 0) {
        raw = [];
      } else {
        const merged = mergeBranches(parentBranches, claim);
        if (blockedByCycle) merged.issues.push({ type: 'depends_on_cycle', detail: 'a cited claim is part of a cycle' });
        raw = [merged];
      }
    } else {
      // single or multiple_alternative: every parent branch stays a distinct branch
      const parentBranches: Branch[] = [];
      let blockedByCycle = false;
      for (const p of knownParents) {
        const pb = expand(p, [...stack, n]);
        if (pb.length === 0) blockedByCycle = true;
        parentBranches.push(...pb);
      }
      if (parentBranches.length === 0) {
        raw = [];
      } else {
        raw = parentBranches.map((pb) => {
          const b = combine(pb, claim);
          if (blockedByCycle) b.issues.push({ type: 'depends_on_cycle', detail: 'a cited claim is part of a cycle' });
          return b;
        });
      }
    }

    const branches = raw.map(checkMutex);
    memo.set(n, branches);
    return branches;
  }

  const all: Branch[] = [];
  for (const c of claims) {
    const branches = expand(c.number, []);
    for (const b of branches) {
      all.push({ ...b, index: all.length });
    }
  }
  return { branches: all, findings };
}
