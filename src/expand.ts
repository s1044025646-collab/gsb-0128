import { AppError } from "./errors.ts";
import type { ClaimInput, CitationIssue, ExpandedBranch } from "./types.ts";

export const DEFAULT_BRANCH_LIMIT = 256;

interface NormalizedClaim {
  claimNo: number;
  kind: ClaimInput["kind"];
  depType: ClaimInput["depType"];
  dependsOn: number[];
  features: string[];
}

/**
 * Static citation checks: duplicate/forward/missing references are rejected at
 * validation time; here we detect dependency cycles and return all issues.
 */
export function checkCitations(claims: ClaimInput[]): CitationIssue[] {
  const issues: CitationIssue[] = [];
  const byNo = new Map(claims.map((c) => [c.claimNo, c]));

  // cycle detection via DFS
  const state = new Map<number, 0 | 1 | 2>();
  const cycleEdges = new Set<string>();
  const dfs = (no: number, stack: number[]): void => {
    if (state.get(no) === 1) {
      const start = stack.indexOf(no);
      const cyc = [...stack.slice(start), no];
      for (let i = 0; i < cyc.length - 1; i++) cycleEdges.add(`${cyc[i]}->${cyc[i + 1]}`);
      return;
    }
    if (state.get(no) === 2) return;
    state.set(no, 1);
    const c = byNo.get(no);
    if (c) for (const d of c.dependsOn) if (byNo.has(d)) dfs(d, [...stack, no]);
    state.set(no, 2);
  };
  for (const c of claims) dfs(c.claimNo, []);
  for (const edge of cycleEdges) {
    const [from, to] = edge.split("->");
    issues.push({ claimNo: Number(from), code: "CYCLIC_REF", detail: `claim ${from} participates in a cycle involving claim ${to}` });
  }

  for (const c of claims) {
    if (c.kind === "dependent" && c.depType === "none") {
      issues.push({ claimNo: c.claimNo, code: "BAD_DEPENDENCY", detail: `dependent claim ${c.claimNo} declares no dependency type` });
    }
    for (const d of c.dependsOn) {
      if (!byNo.has(d)) {
        issues.push({ claimNo: c.claimNo, code: "MISSING_REF", detail: `claim ${c.claimNo} references non-existent claim ${d}` });
      }
    }
  }
  return issues.sort((a, b) => a.claimNo - b.claimNo || a.code.localeCompare(b.code));
}

/**
 * Enumerate every fully-resolved dependency path for one claim.
 * - independent claim -> single path [n]
 * - depType 'any' (任选): one branch PER referenced claim (alternatives)
 * - depType 'all' (同时依赖): cartesian product across referenced claims
 *
 * Features are later merged along each path. A claim reached through more than
 * one 'all' arm contributes its features only once.
 *
 * Paths are returned as ascending claim-number sets; claims can only depend on
 * lower-numbered claims, so ascending order is canonical root-first order.
 */
function enumeratePaths(
  claim: NormalizedClaim,
  byNo: Map<number, NormalizedClaim>,
  stack: number[],
  limit: number,
  count: { n: number },
): number[][] {
  if (stack.includes(claim.claimNo)) {
    throw new AppError("CYCLIC_REF", `dependency cycle at claim ${claim.claimNo}`, {
      cycle: [...stack, claim.claimNo],
    });
  }
  if (claim.kind === "independent" || claim.depType === "none" || claim.dependsOn.length === 0) {
    return [[claim.claimNo]];
  }
  const nextStack = [...stack, claim.claimNo];
  const extend = (path: number[]): number[] =>
    path.includes(claim.claimNo) ? path : [...path, claim.claimNo].sort((a, b) => a - b);

  let combos: number[][];
  if (claim.depType === "any") {
    // 任选: each referenced parent produces its own alternative branches
    combos = claim.dependsOn.flatMap((ref) => {
      const parent = byNo.get(ref);
      if (!parent) throw new AppError("MISSING_REF", `claim ${claim.claimNo} references non-existent claim ${ref}`);
      return enumeratePaths(parent, byNo, nextStack, limit, count).map(extend);
    });
  } else {
    // 同时依赖: cartesian product across referenced claims; shared ancestors union once
    let acc: number[][] = [[]];
    for (const ref of claim.dependsOn) {
      const parent = byNo.get(ref);
      if (!parent) throw new AppError("MISSING_REF", `claim ${claim.claimNo} references non-existent claim ${ref}`);
      const groups = enumeratePaths(parent, byNo, nextStack, limit, count);
      const next: number[][] = [];
      for (const base of acc) {
        for (const g of groups) {
          const merged = new Set([...base, ...g]);
          next.push([...merged].sort((a, b) => a - b));
        }
      }
      acc = next;
    }
    combos = acc.map(extend);
  }
  count.n += combos.length;
  if (count.n > limit) {
    throw new AppError(
      "BRANCH_LIMIT",
      `expansion exceeds branch combination limit of ${limit}; narrow the multi-dependency structure`,
      { limit },
    );
  }
  return combos;
}

function mergeFeaturesAlongPath(path: number[], byNo: Map<number, NormalizedClaim>): string[] {
  const features: string[] = [];
  for (const no of path) {
    const c = byNo.get(no)!;
    for (const f of c.features) if (!features.includes(f)) features.push(f);
  }
  return features;
}

export interface ExpandResult {
  branches: ExpandedBranch[];
  issues: CitationIssue[];
}

/**
 * Expand EVERY claim into its fully inherited branch(es), checking mutex pairs
 * per branch. Dependent claims inherit all features along each dependency path.
 */
export function expandClaims(
  claims: ClaimInput[],
  mutexPairs: [string, string][] = [],
  limit: number = DEFAULT_BRANCH_LIMIT,
): ExpandResult {
  const issues = checkCitations(claims);
  if (issues.some((i) => i.code === "CYCLIC_REF" || i.code === "MISSING_REF")) {
    return { branches: [], issues };
  }
  const byNo = new Map<number, NormalizedClaim>();
  for (const c of claims) {
    byNo.set(c.claimNo, { ...c });
  }

  const branches: ExpandedBranch[] = [];
  let branchNo = 0;
  const roots = [...claims].sort((a, b) => a.claimNo - b.claimNo);

  for (const root of roots) {
    const count = { n: 1 };
    const rawPaths = enumeratePaths(root, byNo, [], limit, count);
    // de-duplicate identical resolved paths for the same root
    const seen = new Set<string>();
    const resolved: number[][] = [];
    for (const path of rawPaths) {
      const key = path.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        resolved.push(path);
      }
    }
    resolved.sort((a, b) => a.join(",").localeCompare(b.join(",")));
    for (const path of resolved) {
      branchNo++;
      const features = mergeFeaturesAlongPath(path, byNo);
      let conflictPair: [string, string] | null = null;
      for (const [fa, fb] of mutexPairs) {
        if (features.includes(fa) && features.includes(fb)) {
          conflictPair = [fa, fb];
          break;
        }
      }
      branches.push({
        branchNo,
        rootClaimNo: root.claimNo,
        path,
        features,
        mutexConflict: conflictPair !== null,
        conflictPair,
      });
    }
  }
  return { branches, issues };
}
