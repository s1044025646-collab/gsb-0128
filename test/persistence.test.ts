import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setupTestDb, seedFixtures, teardownTestDb } from './helpers.ts';
import { closeDb, openDb } from '../src/db.ts';
import { join } from 'node:path';
import { listApplications, getApplication } from '../src/domain/applications.ts';
import { listReferences } from '../src/domain/references.ts';
import { listDictionaries } from '../src/domain/dictionary.ts';
import { createAnalysis, listAnalyses, loadAnalysis } from '../src/domain/analysis.ts';

describe('persistence across restart', () => {
  let dir: string;

  before(() => {
    dir = setupTestDb('persistence');
    seedFixtures();
    createAnalysis({ application_id: 'app-app-jia', dictionary_id: 'dict-dict-v1' });
    closeDb();
  });

  after(() => teardownTestDb());

  it('all data survives closing and reopening the database', () => {
    openDb(join(dir, 'patent.db'));
    assert.equal(listApplications().length, 2);
    assert.equal(listReferences().length, 8);
    assert.equal(listDictionaries().length, 1);
    assert.equal(listAnalyses().length, 1);
    const app = getApplication('app-app-jia');
    assert.equal(app.claims.length, 5);
    const run = listAnalyses()[0]!;
    const loaded = loadAnalysis(run.id);
    assert.equal(loaded.branches.length, 7);
    assert.ok(loaded.references.some((r) => r.branch_results.some((b) => b.fully_covered)));
  });
});
