import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { getTmpDir } from '../src/paths.ts';
import {
  fixtureApplication,
  fixtureBrokenApplication,
  fixtureDictionaryV1,
  fixtureReferences,
} from '../src/fixtures.ts';

function runCli(args: string[], dataDir: string): string {
  return execFileSync(process.execPath, [join(process.cwd(), 'src', 'cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATENT_DATA_DIR: dataDir },
  });
}

describe('CLI smoke', () => {
  const dataDir = join(getTmpDir(), 'test-cli');
  const fixturesDir = join(getTmpDir(), 'test-cli-fixtures');

  before(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fixturesDir, { recursive: true, force: true });
    mkdirSync(fixturesDir, { recursive: true });
  });

  after(() => {
    rmSync(fixturesDir, { recursive: true, force: true });
  });

  it('imports, analyzes, shows coverage, reviews and exports', () => {
    const dictFile = join(fixturesDir, 'dict.json');
    const appFile = join(fixturesDir, 'app.json');
    const brokenFile = join(fixturesDir, 'broken.json');
    const refFile = join(fixturesDir, 'ref.json');
    writeFileSync(dictFile, JSON.stringify(fixtureDictionaryV1()));
    writeFileSync(appFile, JSON.stringify(fixtureApplication()));
    writeFileSync(brokenFile, JSON.stringify(fixtureBrokenApplication()));
    writeFileSync(refFile, JSON.stringify(fixtureReferences()[0]));

    const importDict = JSON.parse(runCli(['import', 'dict', dictFile], dataDir));
    assert.equal(importDict.imported[0].duplicate, false);
    assert.equal(importDict.after_count, 1);
    const importApp = JSON.parse(runCli(['import', 'app', appFile], dataDir));
    assert.equal(importApp.imported[0].duplicate, false);
    const importBroken = JSON.parse(runCli(['import', 'app', brokenFile], dataDir));
    assert.equal(importBroken.imported[0].duplicate, false);
    const importRef = JSON.parse(runCli(['import', 'ref', refFile], dataDir));
    assert.equal(importRef.imported[0].duplicate, false);

    const citations = JSON.parse(runCli(['check', 'citations', 'app-app-bing'], dataDir));
    assert.equal(citations.blocked, true);

    const expansion = JSON.parse(runCli(['expand', 'app-app-jia', '--dict', 'dict-dict-v1'], dataDir));
    assert.equal(expansion.branches.length, 7);

    const analysis = JSON.parse(runCli(['analyze', 'app-app-jia', '--dict', 'dict-dict-v1'], dataDir));
    assert.ok(analysis.run_id);
    assert.ok(analysis.basis_hash);

    runCli(['coverage', analysis.run_id], dataDir);

    const review = JSON.parse(
      runCli(
        ['review', analysis.run_id, '--reviewer', 'cli-user', '--conclusion', 'confirmed_missing', '--branch', '1', '--ref', 'ref-ref-d1', '--feature', 'F4'],
        dataDir,
      ),
    );
    assert.equal(review.review.conclusion, 'confirmed_missing');

    const reviews = JSON.parse(runCli(['reviews', analysis.run_id], dataDir));
    assert.equal(reviews.length, 1);

    const reportPath = join(dataDir, 'report.json');
    runCli(['export', analysis.run_id, '--out', reportPath], dataDir);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.report_type, 'structured_coverage_check');

    const reproduced = JSON.parse(runCli(['reproduce', analysis.run_id], dataDir));
    assert.equal(reproduced.match, true);

    // idempotent re-import
    const again = JSON.parse(runCli(['import', 'app', appFile], dataDir));
    assert.equal(again.imported[0].duplicate, true);
  });
});
