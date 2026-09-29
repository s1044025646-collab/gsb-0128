export type ClaimKind = "independent" | "dependent";
export type DepType = "none" | "any" | "all";

export interface ClaimInput {
  claimNo: number;
  kind: ClaimKind;
  /** 'none' for independent claims; 'any' = alternative (任选); 'all' = simultaneous (同时依赖) */
  depType: DepType;
  dependsOn: number[];
  features: string[];
}

export interface ApplicationInput {
  id?: string;
  title: string;
  filingDate: string;
  priorityDate?: string;
  dictVersion: string;
  claims: ClaimInput[];
  mutexPairs?: [string, string][];
}

export interface DocumentInput {
  id?: string;
  docNo: string;
  title: string;
  pubDate: string;
  disclosures: { feature: string; evidence: string }[];
}

export interface ExpandedBranch {
  branchNo: number;
  rootClaimNo: number;
  /** ordered claim numbers forming this branch, root first */
  path: number[];
  /** features required by this branch, in inheritance order, de-duplicated */
  features: string[];
  mutexConflict: boolean;
  conflictPair: [string, string] | null;
}

export interface CitationIssue {
  claimNo: number;
  code: "CYCLIC_REF" | "MISSING_REF" | "BAD_DEPENDENCY";
  detail: string;
}

export type CoverageStatus = "disclosed" | "equivalent" | "missing";

export interface CoverageItem {
  feature: string;
  status: CoverageStatus;
  /** disclosure record used as evidence, if any */
  evidence: string | null;
  /** feature in the document that matched via dictionary equivalence */
  matchedFeature: string | null;
}

export interface BranchCoverage {
  branchNo: number;
  docId: string;
  docNo: string;
  inScope: boolean;
  isPriorArt: boolean;
  covered: boolean;
  items: CoverageItem[];
  missing: string[];
}

export interface ReviewIssue {
  subject: string;
  issueType: string;
  detail: string;
}
