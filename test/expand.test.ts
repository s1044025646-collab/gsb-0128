import { test } from "node:test";
import assert from "node:assert/strict";
import { expandClaims, checkCitations, DEFAULT_BRANCH_LIMIT } from "../src/expand.ts";
import { loadFixture } from "./helpers.ts";
import { validateApplication } from "../src/validation.ts";
import type { ClaimInput } from "../src/types.ts";
import { AppError } from "../src/errors.ts";

const app = validateApplication(loadFixture("app-main.json"));

test("multi-layer dependent claims inherit all ancestor features in order", () => {
  const { branches } = expandClaims(app.claims, app.mutexPairs);
  const b4 = branches.find((b) => b.rootClaimNo === 4)!;
  assert.deepEqual(b4.path, [1, 2, 3, 4]);
  assert.deepEqual(b4.features, ["F1_widget", "F2_fastener", "F3_spring", "F4_display", "F5_lever"]);
});

test("'any' multi-dependency keeps distinct alternative branches", () => {
  const { branches } = expandClaims(app.claims, app.mutexPairs);
  const b9 = branches.filter((b) => b.rootClaimNo === 9);
  assert.equal(b9.length, 2, "claim 9 (any of 4,8) must yield two branches");
  const paths = b9.map((b) => b.path.join(",")).sort();
  assert.deepEqual(paths, ["1,2,3,4,9", "1,8,9"]);
  const via8 = b9.find((b) => b.path.includes(8))!;
  assert.ok(via8.features.includes("F9_manual_knob"));
  assert.ok(!via8.features.includes("F3_spring"), "alternative branch must not inherit the unchosen arm");
});

test("'all' multi-dependency unions simultaneous ancestors", () => {
  const { branches } = expandClaims(app.claims, app.mutexPairs);
  const b5 = branches.find((b) => b.rootClaimNo === 5)!;
  assert.deepEqual(b5.path, [1, 2, 3, 4, 5]);
  const b7 = branches.find((b) => b.rootClaimNo === 7)!;
  assert.deepEqual(b7.path, [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(b7.features.includes("F6_metal_housing"));
  assert.ok(b7.features.includes("F7_battery"));
});

test("branch completeness: exactly 12 branches for fixture", () => {
  const { branches } = expandClaims(app.claims, app.mutexPairs);
  assert.equal(branches.length, 12);
});

test("mutually exclusive features flag the branch", () => {
  const { branches } = expandClaims(app.claims, app.mutexPairs);
  const b10 = branches.find((b) => b.rootClaimNo === 10)!;
  assert.equal(b10.mutexConflict, true);
  assert.deepEqual(b10.conflictPair, ["F5_lever", "F9_manual_knob"]);
  const clean = branches.filter((b) => b.rootClaimNo !== 10);
  assert.ok(clean.every((b) => !b.mutexConflict));
});

test("cyclic references are detected without crashing", () => {
  const cyclic: ClaimInput[] = [
    { claimNo: 1, kind: "independent", depType: "none", dependsOn: [], features: ["A"] },
    { claimNo: 2, kind: "dependent", depType: "any", dependsOn: [3], features: ["B"] },
    { claimNo: 3, kind: "dependent", depType: "any", dependsOn: [2], features: ["C"] },
  ];
  const issues = checkCitations(cyclic);
  assert.ok(issues.some((i) => i.code === "CYCLIC_REF"));
  const expanded = expandClaims(cyclic);
  assert.deepEqual(expanded.branches, []);
});

test("references to non-existent claims are reported", () => {
  const bad: ClaimInput[] = [
    { claimNo: 1, kind: "independent", depType: "none", dependsOn: [], features: ["A"] },
    { claimNo: 2, kind: "dependent", depType: "any", dependsOn: [9], features: ["B"] },
  ];
  const issues = checkCitations(bad);
  assert.ok(issues.some((i) => i.code === "MISSING_REF" && i.claimNo === 2));
});

test("branch combination limit is enforced", () => {
  // each level combines a growing-branch claim with a 2-branch claim -> exponential
  const claims: ClaimInput[] = [
    { claimNo: 1, kind: "independent", depType: "none", dependsOn: [], features: ["A"] },
    { claimNo: 2, kind: "independent", depType: "none", dependsOn: [], features: ["B"] },
    { claimNo: 3, kind: "dependent", depType: "any", dependsOn: [1, 2], features: ["C"] },
  ];
  for (let cur = 4; cur <= 8; cur++) {
    claims.push({ claimNo: cur, kind: "dependent", depType: "all", dependsOn: [cur - 1, 3], features: [`X${cur}`] });
  }
  assert.throws(
    () => expandClaims(claims, [], 8),
    (e: unknown) => e instanceof AppError && e.code === "BRANCH_LIMIT",
  );
});

test("default branch limit is a defined finite cap", () => {
  assert.equal(DEFAULT_BRANCH_LIMIT, 256);
});
