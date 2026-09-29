import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb, seedMainApp } from "./helpers.ts";
import { createAnalysis } from "../src/analysis.ts";
import type { BranchCoverage } from "../src/types.ts";

test("date boundary: same-day and later publications are not prior art", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const res = createAnalysis(db, appId);
    const find = (docNo: string, branchNo = 1) =>
      res.coverage.find((c) => c.docNo === docNo && c.branchNo === branchNo)!;
    assert.equal(find("D1").isPriorArt, true);
    assert.equal(find("D2").isPriorArt, true);
    assert.equal(find("D3").isPriorArt, false, "published exactly on priority date");
    assert.equal(find("D4").isPriorArt, false, "published after priority date");
    assert.equal(find("D3").covered, false);
    assert.equal(find("D4").covered, false);
  } finally {
    cleanup();
  }
});

test("single document must disclose all features; split disclosures cannot be stitched", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const res = createAnalysis(db, appId);
    const d5 = res.coverage.find((c) => c.docNo === "D5" && c.branchNo === 1)!;
    const d6 = res.coverage.find((c) => c.docNo === "D6" && c.branchNo === 1)!;
    assert.equal(d5.covered, false);
    assert.equal(d6.covered, false);
    assert.deepEqual(d5.missing, ["F2_fastener"]);
    assert.deepEqual(d6.missing, ["F1_widget"]);
    // even though D5+D6 together would cover branch 1, neither cell alone is covered
    assert.equal(res.coverage.filter((c) => c.docNo === "D5" || c.docNo === "D6").some((c) => c.covered), false);
  } finally {
    cleanup();
  }
});

test("equivalence only via versioned dictionary, with item-level evidence", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const res = createAnalysis(db, appId);
    // claim 4 branch includes F5_lever; D2 discloses "actuator" (dict-v1 equivalent)
    const d2b4: BranchCoverage = res.coverage.find((c) => c.docNo === "D2" && c.branchNo === 4)!;
    const lever = d2b4.items.find((i) => i.feature === "F5_lever")!;
    assert.equal(lever.status, "equivalent");
    assert.equal(lever.matchedFeature, "actuator");
    assert.match(lever.evidence ?? "", /actuator/);
    const direct = d2b4.items.find((i) => i.feature === "F1_widget")!;
    assert.equal(direct.status, "disclosed");
  } finally {
    cleanup();
  }
});

test("D2 completely anticipates the fully-featured branch in one document", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const res = createAnalysis(db, appId);
    const d2 = res.coverage.filter((c) => c.docNo === "D2");
    // branch 7 inherits features through claim 7; D2 discloses every one
    const b7 = d2.find((c) => c.branchNo === 7)!;
    assert.equal(b7.covered, true);
    assert.deepEqual(b7.missing, []);
    assert.equal(res.summary.novelty, "anticipated");
  } finally {
    cleanup();
  }
});

test("unknown relationships create pending review flags rather than guessed matches", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const res = createAnalysis(db, appId);
    // F11_quantum_link is never disclosed and has no dictionary relationship
    assert.ok(
      res.reviewIssues.some((f) => f.issueType === "UNKNOWN_FEATURE" && f.subject === "F11_quantum_link"),
    );
  } finally {
    cleanup();
  }
});

test("scope restriction limits compared documents", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const d1 = db.prepare("SELECT id FROM documents WHERE doc_no='D1'").get() as { id: string };
    const res = createAnalysis(db, appId, [d1.id]);
    assert.equal(res.summary.docCount, 1);
    const b1 = res.coverage.find((c) => c.branchNo === 1)!;
    assert.equal(b1.covered, true, "D1 alone discloses F1+F2");
    const b2 = res.coverage.find((c) => c.branchNo === 2)!;
    assert.equal(b2.covered, false, "D1 does not disclose F3_spring");
  } finally {
    cleanup();
  }
});
