import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDb, closeDb, migrate } from './db.ts';
import { migration001 } from './migrations/001_init.ts';
import { getDataDir, getProjectRoot } from './paths.ts';
import { createDictionary, listDictionaries, getDictionary } from './domain/dictionary.ts';
import { createApplication, listApplications, getApplication } from './domain/applications.ts';
import { createReference, listReferences } from './domain/references.ts';
import { expandClaims, mutexKey, type Finding } from './domain/expansion.ts';
import { createAnalysis, listAnalyses, loadAnalysis, reproduceAnalysis } from './domain/analysis.ts';
import { addReview, listReviews, REVIEW_CONCLUSIONS } from './domain/reviews.ts';
import { buildReport } from './domain/report.ts';
import { startServer } from './api/server.ts';
import { runDemo } from './demo.ts';
import { AppError } from './errors.ts';

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readJsonFile(file: string): unknown {
  const path = resolve(file);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`failed to read JSON file ${path}: ${(err as Error).message}`);
  }
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1];
}

function requireFlag(args: string[], name: string): string {
  const v = flag(args, name);
  if (v == null) throw new Error(`--${name} is required`);
  return v;
}

function openDatabase(): void {
  const dataDir = getDataDir();
  const db = openDb(join(dataDir, 'patent.db'));
  migrate(db, [migration001]);
}

function cmdMigrate(): void {
  openDatabase();
  print({ migrated: true, data_dir: getDataDir() });
}

function cmdImport(kind: string, file: string): void {
  const data = readJsonFile(file);
  const items = Array.isArray(data) ? data : [data];
  if (kind === 'dict') {
    const before = listDictionaries().length;
    const imported = items.map((item) => {
      const { record, duplicate } = createDictionary(item);
      return { external_id: record.external_id, duplicate };
    });
    print({ before_count: before, after_count: listDictionaries().length, imported });
  } else if (kind === 'app') {
    const before = listApplications().length;
    const imported = items.map((item) => {
      const { record, duplicate } = createApplication(item);
      return { external_id: record.external_id, duplicate, claims: record.claims.length };
    });
    print({ before_count: before, after_count: listApplications().length, imported });
  } else if (kind === 'ref') {
    const before = listReferences().length;
    const imported = items.map((item) => {
      const { record, duplicate } = createReference(item);
      return { external_id: record.external_id, duplicate };
    });
    print({ before_count: before, after_count: listReferences().length, imported });
  } else {
    throw new Error(`unknown import kind: ${kind} (expected dict|app|ref)`);
  }
}

function cmdList(kind: string): void {
  if (kind === 'apps') print(listApplications());
  else if (kind === 'refs') print(listReferences());
  else if (kind === 'dicts') print(listDictionaries());
  else if (kind === 'analyses') print(listAnalyses());
  else throw new Error(`unknown list kind: ${kind} (expected apps|refs|dicts|analyses)`);
}

function cmdCitations(appId: string): void {
  const app = getApplication(appId);
  const result = expandClaims(app.claims, new Set());
  print({ application_id: appId, findings: result.findings, blocked: result.findings.some((f) => f.type === 'cycle' || f.type === 'missing_citation') });
}

function cmdExpand(appId: string, args: string[]): void {
  const dictId = flag(args, 'dict');
  const app = getApplication(appId);
  let mutexPairs = new Set<string>();
  if (dictId) {
    const dict = getDictionary(dictId);
    mutexPairs = new Set(dict.mutex.map((m) => mutexKey(m.code_a, m.code_b)));
  }
  const result = expandClaims(app.claims, mutexPairs);
  print({
    application_id: appId,
    dictionary_id: dictId ?? null,
    findings: result.findings,
    branches: result.branches.map((b) => ({
      index: b.index,
      claim_number: b.claim_number,
      path: b.path,
      included_claims: b.included_claims,
      features: b.features,
      issues: b.issues,
    })),
  });
}

function cmdAnalyze(appId: string, args: string[]): void {
  const dictionaryId = requireFlag(args, 'dict');
  const refsFlag = flag(args, 'refs');
  const scope = refsFlag ? refsFlag.split(',').map((s) => s.trim()).filter(Boolean) : 'all';
  const result = createAnalysis({
    application_id: appId,
    dictionary_id: dictionaryId,
    effective_date: flag(args, 'effective'),
    scope,
    note: flag(args, 'note'),
  });
  const claimByBranch = new Map(result.branches.map((b) => [b.index, b.claim_number]));
  print({
    run_id: result.run.id,
    basis_hash: result.run.basis_hash,
    effective_date: result.run.effective_date,
    branches: result.branches.length,
    references: result.references.length,
    fully_covered_branches: result.references
      .filter((r) => r.eligible)
      .flatMap((r) =>
        r.branch_results
          .filter((b) => b.fully_covered)
          .map((b) => ({ ref: r.external_id, branch: b.branch_index, claim: claimByBranch.get(b.branch_index) })),
      ),
  });
}

function cmdCoverage(analysisId: string): void {
  const result = loadAnalysis(analysisId);
  const claimByBranch = new Map(result.branches.map((b) => [b.index, b.claim_number]));
  const header = ['reference', 'pub_date', 'eligible', 'branch', 'claim', 'covered', 'disclosed', 'missing', 'review'];
  const rows: (string | number)[][] = [];
  for (const ref of result.references) {
    for (const br of ref.branch_results) {
      rows.push([
        ref.external_id,
        ref.publication_date,
        ref.eligible ? 'yes' : 'no',
        br.branch_index,
        claimByBranch.get(br.branch_index) ?? '-',
        br.fully_covered ? 'YES' : '-',
        br.disclosed_count,
        br.missing_count,
        br.review_count,
      ]);
    }
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells: (string | number)[]) => cells.map((c, i) => String(c).padEnd(widths[i]!)).join('  ');
  process.stdout.write(`${line(header)}\n${rows.map(line).join('\n')}\n`);
}

function cmdReview(analysisId: string, args: string[]): void {
  const reviewer = requireFlag(args, 'reviewer');
  const conclusion = requireFlag(args, 'conclusion');
  if (!REVIEW_CONCLUSIONS.includes(conclusion as (typeof REVIEW_CONCLUSIONS)[number])) {
    throw new Error(`conclusion must be one of ${REVIEW_CONCLUSIONS.join(', ')}`);
  }
  const review = addReview(analysisId, {
    reviewer,
    conclusion,
    branch_index: flag(args, 'branch') == null ? null : Number(flag(args, 'branch')),
    reference_id: flag(args, 'ref') ?? null,
    feature_code: flag(args, 'feature') ?? null,
    note: flag(args, 'note') ?? null,
  });
  print({ review });
}

function cmdExport(analysisId: string, args: string[]): void {
  const report = buildReport(analysisId);
  const out = flag(args, 'out');
  if (out) {
    writeFileSync(resolve(out), JSON.stringify(report, null, 2), 'utf8');
    print({ exported: true, file: resolve(out) });
  } else {
    print(report);
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      'patent-cli commands:',
      '  migrate                                   run pending migrations',
      '  import dict|app|ref <file.json>           import fixtures (idempotent)',
      '  list apps|refs|dicts|analyses             list records',
      '  check citations <appId>                   detect cycles / missing citations',
      '  expand <appId> [--dict <dictId>]          expand dependent claim branches',
      '  analyze <appId> --dict <dictId> [--refs id,...] [--effective YYYY-MM-DD] [--note text]',
      '  coverage <analysisId>                     show coverage matrix',
      '  review <analysisId> --reviewer <name> --conclusion <c> [--branch n] [--ref id] [--feature code] [--note text]',
      '  reviews <analysisId>                      list manual reviews',
      '  reproduce <analysisId>                    recompute from frozen snapshot',
      '  export <analysisId> [--out file.json]     export JSON report',
      '  serve [--host 127.0.0.1] [--port 0]       start API server (auto port)',
      '  demo                                      run repeatable end-to-end demo',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let keepDbOpen = false;
  try {
    switch (command) {
      case 'migrate':
        cmdMigrate();
        break;
      case 'import':
        openDatabase();
        cmdImport(rest[0]!, rest[1]!);
        break;
      case 'list':
        openDatabase();
        cmdList(rest[0]!);
        break;
      case 'check':
        openDatabase();
        if (rest[0] !== 'citations') throw new Error('check only supports "citations"');
        cmdCitations(rest[1]!);
        break;
      case 'expand':
        openDatabase();
        cmdExpand(rest[0]!, rest.slice(1));
        break;
      case 'analyze':
        openDatabase();
        cmdAnalyze(rest[0]!, rest.slice(1));
        break;
      case 'coverage':
        openDatabase();
        cmdCoverage(rest[0]!);
        break;
      case 'review':
        openDatabase();
        cmdReview(rest[0]!, rest.slice(1));
        break;
      case 'reviews':
        openDatabase();
        print(listReviews(rest[0]!));
        break;
      case 'reproduce':
        openDatabase();
        print(reproduceAnalysis(rest[0]!));
        break;
      case 'export':
        openDatabase();
        cmdExport(rest[0]!, rest.slice(1));
        break;
      case 'serve': {
        openDatabase();
        const host = flag(rest, 'host') ?? '127.0.0.1';
        const port = Number(flag(rest, 'port') ?? '0');
        const { port: actualPort } = await startServer({ host, port });
        print({ serving: true, host, port: actualPort, data_dir: getDataDir() });
        keepDbOpen = true;
        break;
      }
      case 'demo':
        keepDbOpen = true;
        await runDemo();
        break;
      default:
        printUsage();
        if (command) process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof AppError) {
      print({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    } else {
      print({ error: { code: 'ERROR', message: (err as Error).message } });
    }
    process.exitCode = 1;
  } finally {
    if (!keepDbOpen) closeDb();
  }
}

void main();
