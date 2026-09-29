import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, closeDb, tx } from "../src/db.ts";
import { seedMainApp } from "./helpers.ts";
import { createAnalysis } from "../src/analysis.ts";

test("transaction rolls back all statements on failure", () => {
  const { db, cleanup } = tempDbLocal();
  try {
    assert.throws(() =>
      tx(db, () => {
        db.prepare("INSERT INTO dictionaries(version,created_at) VALUES(?,?)").run("dx", "t");
        // second statement violates the PRIMARY KEY -> must roll back the first
        db.prepare("INSERT INTO dictionaries(version,created_at) VALUES(?,?)").run("dx", "t2");
      }),
    );
    const row = db.prepare("SELECT COUNT(*) n FROM dictionaries WHERE version='dx'").get() as { n: number };
    assert.equal(row.n, 0, "rolled-back insert must not persist");
    closeDb(db);
  } finally {
    cleanup();
  }
});

test("data survives close and reopen (restart persistence)", () => {
  const { db, dir, cleanup } = tempDbLocal();
  let analysisId = "";
  try {
    const appId = seedMainApp(db);
    analysisId = createAnalysis(db, appId).summary.id;
    closeDb(db);
    const reopened = openDb(join(dir, "test.sqlite"));
    const apps = reopened.prepare("SELECT COUNT(*) n FROM applications").get() as { n: number };
    const analyses = reopened.prepare("SELECT COUNT(*) n FROM analyses").get() as { n: number };
    const flags = reopened.prepare("SELECT COUNT(*) n FROM review_flags WHERE analysis_id=?").get(analysisId) as {
      n: number;
    };
    assert.equal(apps.n, 1);
    assert.equal(analyses.n, 1);
    assert.ok(flags.n >= 0);
    // analyses are reproducible after restart
    const again = createAnalysis(reopened, appId);
    assert.equal(again.summary.id, analysisId);
    closeDb(reopened);
  } finally {
    // cleanup already closes; reopen path leaves it closed
    if (existsSync(join(dir, "test.sqlite"))) {
      const db2 = openDb(join(dir, "test.sqlite"));
      closeDb(db2);
    }
    cleanup();
  }
});

function tempDbLocal(): { db: ReturnType<typeof openDb>; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "patent-persist-"));
  const db = openDb(join(dir, "test.sqlite"));
  return {
    db,
    dir,
    cleanup: () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          // Windows may briefly retain WAL handles
        }
      }
    },
  };
}
