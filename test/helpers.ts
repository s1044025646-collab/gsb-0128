import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb, closeDb } from "../src/db.ts";
import { setClock } from "../src/clock.ts";
import { importApplication, importDictionary, importDocument } from "../src/repository.ts";
import { validateApplication, validateDictVersion, validateDocument } from "../src/validation.ts";
import { readFileSync } from "node:fs";
import type { ApplicationInput } from "../src/types.ts";

export function tempDb(): { db: DatabaseSync; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "patent-test-"));
  const db = openDb(join(dir, "test.sqlite"));
  return {
    db,
    dir,
    cleanup: () => {
      closeDb(db);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function freezeTime(iso: string): void {
  setClock(iso);
}
export function unfreezeTime(): void {
  setClock(null);
}

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join("fixtures", name), "utf8"));
}

export function seedMainApp(db: DatabaseSync): string {
  const dict = validateDictVersion(loadFixture("dict-v1.json"));
  importDictionary(db, dict.version, dict.equivalences);
  const app = validateApplication(loadFixture("app-main.json"));
  const res = importApplication(db, app);
  const docs = (loadFixture("documents.json") as unknown[]).map(validateDocument);
  for (const d of docs) importDocument(db, d);
  return res.id;
}

export function makeApp(overrides: Partial<ApplicationInput> = {}): ApplicationInput {
  return {
    title: "T",
    filingDate: "2021-06-01",
    priorityDate: "2020-06-01",
    dictVersion: "dict-v1",
    claims: [
      { claimNo: 1, kind: "independent", depType: "none", dependsOn: [], features: ["A"] },
    ],
    ...overrides,
  };
}
