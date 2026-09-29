import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const cli = "src/cli/index.ts";

async function cliRun(args: string[], cwd: string, dbPath: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, ["--no-warnings=ExperimentalWarning", cli, ...args], {
      cwd,
      env: { ...process.env, PATENT_DB_PATH: dbPath },
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; code?: number };
    return { stdout: e.stdout ?? "", code: e.code ?? 1 };
  }
}

test("CLI end-to-end: import, check, expand, analyze, matrix, review, export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "patent-cli-"));
  const cwd = process.cwd();
  const dbPath = join(dir, "cli.sqlite");
  try {
    assert.equal((await cliRun(["import-dict", "fixtures/dict-v1.json"], cwd, dbPath)).code, 0);
    assert.equal((await cliRun(["import-app", "fixtures/app-main.json"], cwd, dbPath)).code, 0);
    // idempotent re-import
    const repeat = await cliRun(["import-app", "fixtures/app-main.json"], cwd, dbPath);
    assert.match(repeat.stdout, /idempotent/);
    assert.equal((await cliRun(["import-doc", "fixtures/documents.json"], cwd, dbPath)).code, 0);
    const check = await cliRun(["check-citations", "app-demo-0001"], cwd, dbPath);
    assert.match(check.stdout, /OK/);
    const expand = await cliRun(["expand", "app-demo-0001"], cwd, dbPath);
    assert.match(expand.stdout, /12 branch/);
    assert.match(expand.stdout, /MUTEX/);
    const analyze = await cliRun(["analyze", "app-demo-0001"], cwd, dbPath);
    assert.match(analyze.stdout, /anticipated/);
    const aid = analyze.stdout.match(/analysis (an_[0-9a-f]+)/)![1]!;
    const matrix = await cliRun(["matrix", aid], cwd, dbPath);
    assert.match(matrix.stdout, /D2/);
    const out = join(dir, "report.md");
    assert.equal((await cliRun(["export", aid, "--out", out], cwd, dbPath)).code, 0);
    assert.ok(existsSync(out));
    // defective fixture via --file
    const bad = await cliRun(["check-citations", "--file", "fixtures/app-bad-citations.json"], cwd, dbPath);
    assert.equal(bad.code, 2);
    assert.match(bad.stdout, /CYCLIC_REF/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
