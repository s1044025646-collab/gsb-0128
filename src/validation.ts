import { AppError } from "./errors.ts";
import { isIsoDate } from "./clock.ts";
import type { ApplicationInput, ClaimInput, DocumentInput } from "./types.ts";

function fail(msg: string, details?: unknown): never {
  throw new AppError("VALIDATION_ERROR", msg, details);
}

export function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim() === "") fail(`${field} must be a non-empty string`);
  return v as string;
}

export function requireDate(v: unknown, field: string): string {
  if (!isIsoDate(v)) fail(`${field} must be an ISO date YYYY-MM-DD`);
  return v;
}

export function requireStringArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim() === "")) {
    fail(`${field} must be an array of non-empty strings`);
  }
  return v as string[];
}

export function validateClaim(raw: unknown, index: number): ClaimInput {
  if (typeof raw !== "object" || raw === null) fail(`claims[${index}] must be an object`);
  const c = raw as Record<string, unknown>;
  const claimNo = c.claimNo;
  if (!Number.isInteger(claimNo) || (claimNo as number) < 1) fail(`claims[${index}].claimNo must be a positive integer`);
  const kind = c.kind;
  if (kind !== "independent" && kind !== "dependent") fail(`claims[${index}].kind must be independent|dependent`);
  const depType = c.depType;
  if (depType !== "none" && depType !== "any" && depType !== "all") {
    fail(`claims[${index}].depType must be none|any|all`);
  }
  if (!Array.isArray(c.dependsOn) || c.dependsOn.some((x) => !Number.isInteger(x) || (x as number) < 1)) {
    fail(`claims[${index}].dependsOn must be an array of positive integers`);
  }
  const dependsOn = [...(c.dependsOn as number[])].sort((a, b) => a - b);
  const features = requireStringArray(c.features, `claims[${index}].features`);
  if (kind === "independent") {
    if (depType !== "none" || dependsOn.length !== 0) {
      fail(`claims[${index}]: independent claim must declare depType none and no dependencies`);
    }
  } else if (dependsOn.length === 0 || depType === "none") {
    fail(`claims[${index}]: dependent claim must have depType any|all and at least one dependency`);
  }
  return { claimNo: claimNo as number, kind, depType, dependsOn, features: [...new Set(features)] };
}

export function validateApplication(raw: unknown): ApplicationInput {
  if (typeof raw !== "object" || raw === null) fail("application must be an object");
  const a = raw as Record<string, unknown>;
  const title = requireString(a.title, "title");
  const filingDate = requireDate(a.filingDate, "filingDate");
  const priorityDate = a.priorityDate === undefined ? filingDate : requireDate(a.priorityDate, "priorityDate");
  if (priorityDate > filingDate) fail("priorityDate cannot be later than filingDate");
  const dictVersion = requireString(a.dictVersion, "dictVersion");
  if (!Array.isArray(a.claims) || a.claims.length === 0) fail("claims must be a non-empty array");
  const claims = a.claims.map((c, i) => validateClaim(c, i));
  const nos = new Set<number>();
  for (const c of claims) {
    if (nos.has(c.claimNo)) fail(`duplicate claim number ${c.claimNo}`);
    nos.add(c.claimNo);
  }
  // dependency target numbers must refer to existing claim numbers
  for (const c of claims) {
    for (const d of c.dependsOn) {
      if (!nos.has(d)) fail(`claim ${c.claimNo} depends on missing claim ${d}`);
      if (d >= c.claimNo) fail(`claim ${c.claimNo} cannot depend on later/same claim ${d}`);
    }
    if (new Set(c.dependsOn).size !== c.dependsOn.length) {
      fail(`claim ${c.claimNo} has duplicate dependencies`);
    }
  }
  const mutexPairs: [string, string][] = [];
  if (a.mutexPairs !== undefined) {
    if (!Array.isArray(a.mutexPairs)) fail("mutexPairs must be an array of [feature, feature]");
    a.mutexPairs.forEach((p, i) => {
      if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string") {
        fail(`mutexPairs[${i}] must be [string, string]`);
      }
      mutexPairs.push([p[0], p[1]]);
    });
  }
  return {
    id: typeof a.id === "string" ? a.id : undefined,
    title,
    filingDate,
    priorityDate,
    dictVersion,
    claims,
    mutexPairs,
  };
}

export function validateDocument(raw: unknown): DocumentInput {
  if (typeof raw !== "object" || raw === null) fail("document must be an object");
  const d = raw as Record<string, unknown>;
  const docNo = requireString(d.docNo, "docNo");
  const title = requireString(d.title, "title");
  const pubDate = requireDate(d.pubDate, "pubDate");
  if (!Array.isArray(d.disclosures)) fail("disclosures must be an array");
  const seen = new Set<string>();
  const disclosures = d.disclosures.map((x, i) => {
    if (typeof x !== "object" || x === null) fail(`disclosures[${i}] must be an object`);
    const rec = x as Record<string, unknown>;
    const feature = requireString(rec.feature, `disclosures[${i}].feature`);
    const evidence = requireString(rec.evidence, `disclosures[${i}].evidence`);
    if (seen.has(feature)) fail(`duplicate disclosure for feature ${feature}`);
    seen.add(feature);
    return { feature, evidence };
  });
  return { id: typeof d.id === "string" ? d.id : undefined, docNo, title, pubDate, disclosures };
}

export function validateDictVersion(raw: unknown): { version: string; equivalences: [string, string][] } {
  if (typeof raw !== "object" || raw === null) fail("dictionary must be an object");
  const d = raw as Record<string, unknown>;
  const version = requireString(d.version, "version");
  if (!Array.isArray(d.equivalences)) fail("equivalences must be an array of [feature, feature]");
  const equivalences: [string, string][] = d.equivalences.map((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string") {
      fail(`equivalences[${i}] must be [string, string]`);
    }
    if (p[0] === p[1]) fail(`equivalences[${i}] must reference two different features`);
    return [p[0], p[1]];
  });
  return { version, equivalences };
}
