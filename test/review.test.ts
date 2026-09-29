import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb, seedMainApp } from "./helpers.ts";
import { createAnalysis, listFlags, reviewFlag } from "../src/analysis.ts";
import { AppError } from "../src/errors.ts";

test("manual review conclusion updates a pending flag; bad flag id errors", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const res = createAnalysis(db, appId);
    assert.ok(res.reviewIssues.length > 0);
    const flagId = (listFlags(db, res.summary.id)[0] as { id: string }).id;
    reviewFlag(db, flagId, "rejected", "examiner-x", "not relevant to this branch");
    const updated = listFlags(db, res.summary.id, "rejected") as {
      status: string;
      reviewer: string;
      conclusion: string;
    }[];
    assert.equal(updated.length, 1);
    assert.equal(updated[0]!.reviewer, "examiner-x");
    assert.throws(() => reviewFlag(db, "fl_nope", "confirmed", "x"), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
  } finally {
    cleanup();
  }
});
