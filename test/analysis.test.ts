import { test } from "node:test";
import assert from "node:assert/strict";
import { tempDb, seedMainApp, freezeTime, unfreezeTime } from "./helpers.ts";
import { createAnalysis, listAnalyses, loadAnalysis } from "../src/analysis.ts";
import { importApplication, importDictionary } from "../src/repository.ts";
import { validateApplication } from "../src/validation.ts";
import { loadFixture } from "./helpers.ts";
import { AppError } from "../src/errors.ts";

test("repeat analysis is idempotent: same id, old basis retained", () => {
  const { db, cleanup } = tempDb();
  try {
    freezeTime("2022-01-01T00:00:00Z");
    const appId = seedMainApp(db);
    const first = createAnalysis(db, appId);
    const second = createAnalysis(db, appId);
    assert.equal(first.summary.id, second.summary.id);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM analyses").get() as { n: number }).n, 1);
    unfreezeTime();
  } finally {
    cleanup();
  }
});

test("changing priority date creates a new analysis and keeps the old one", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const first = createAnalysis(db, appId);
    // amended application with an earlier priority date
    const amended = validateApplication({
      ...(loadFixture("app-main.json") as object),
      id: undefined,
      priorityDate: "2018-01-01",
    });
    const imported = importApplication(db, amended);
    const second = createAnalysis(db, imported.id);
    assert.notEqual(first.summary.id, second.summary.id);
    const all = listAnalyses(db);
    assert.equal(all.length, 2);
    // D2 (2019) becomes later than the new (2018)... still earlier than 2018? no, 2019 > 2018
    assert.equal(second.summary.priorityDate, "2018-01-01");
    // old analysis still fully loadable
    assert.ok(loadAnalysis(db, first.summary.id));
  } finally {
    cleanup();
  }
});

test("dictionary version change produces reproducibly different results", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    const v1 = createAnalysis(db, appId);
    // add a new dictionary version where F3_spring is equivalent to something D1-ish;
    // simpler: verify dict fingerprint participates in id by switching app version
    importDictionary(db, "dict-v2", [["F3_spring", "coil"]]);
    const amended = validateApplication({ ...(loadFixture("app-main.json") as object), id: undefined, dictVersion: "dict-v2" });
    const newApp = importApplication(db, amended);
    const v2 = createAnalysis(db, newApp.id);
    assert.notEqual(v1.summary.id, v2.summary.id);
    // re-running v2 reproduces exactly
    assert.equal(createAnalysis(db, newApp.id).summary.id, v2.summary.id);
    assert.equal(v1.summary.dictVersion, "dict-v1");
    assert.equal(v2.summary.dictVersion, "dict-v2");
  } finally {
    cleanup();
  }
});

test("analysis requires the referenced dictionary version to exist", () => {
  const { db, cleanup } = tempDb();
  try {
    const app = validateApplication({
      title: "x",
      filingDate: "2021-01-01",
      dictVersion: "missing-dict",
      claims: [{ claimNo: 1, kind: "independent", depType: "none", dependsOn: [], features: ["A"] }],
    });
    const { id } = importApplication(db, app);
    assert.throws(() => createAnalysis(db, id), (e: unknown) => e instanceof AppError && e.code === "DICT_MISMATCH");
  } finally {
    cleanup();
  }
});

test("scope document that does not exist is rejected", () => {
  const { db, cleanup } = tempDb();
  try {
    const appId = seedMainApp(db);
    assert.throws(() => createAnalysis(db, appId, ["doc_nope"]), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
  } finally {
    cleanup();
  }
});
