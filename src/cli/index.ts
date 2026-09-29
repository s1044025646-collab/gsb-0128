#!/usr/bin/env node
import { readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { openDb, closeDb, getDb } from "../db.ts";
import {
  importApplication,
  importDictionary,
  importDocument,
  getClaims,
  rowToClaim,
  getMutexPairs,
} from "../repository.ts";
import { validateApplication, validateDictVersion, validateDocument } from "../validation.ts";
import { checkCitations, expandClaims, DEFAULT_BRANCH_LIMIT } from "../expand.ts";
import { createAnalysis, loadAnalysis, listFlags, reviewFlag, listAnalyses } from "../analysis.ts";
import { AppError } from "../errors.ts";
import { renderReport } from "../report.ts";
import type { ClaimInput } from "../types.ts";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function count(table: string): number {
  return (getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
}

function statusLine(label: string, before: Record<string, number>, after: Record<string, number>): void {
  const parts = Object.keys(after).map((k) => `${k}: ${before[k] ?? 0} -> ${after[k]}`);
  console.log(`${label}  [${parts.join(", ")}]`);
}

const cmd = process.argv[2];
const args = process.argv.slice(3);

function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function positional(i: number): string | undefined {
  return args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--docs")[i];
}

try {
  switch (cmd) {
    case "import-dict": {
      const file = positional(0);
      if (!file) fail("usage: import-dict <file.json>");
      const db = openDb();
      const before = { dictionaries: count("dictionaries"), equivalences: count("dict_equivalences") };
      const v = validateDictVersion(readJson(file!));
      const res = importDictionary(db, v.version, v.equivalences);
      statusLine(`dictionary ${v.version} ${res.created ? "imported" : "already present"}`, before, {
        dictionaries: count("dictionaries"),
        equivalences: count("dict_equivalences"),
      });
      closeDb(db);
      break;
    }
    case "import-app": {
      const file = positional(0);
      if (!file) fail("usage: import-app <file.json>");
      const db = openDb();
      const before = { applications: count("applications"), claims: count("claims") };
      const app = validateApplication(readJson(file!));
      const res = importApplication(db, app);
      statusLine(`application ${res.id} ${res.created ? "imported" : "unchanged (idempotent)"}`, before, {
        applications: count("applications"),
        claims: count("claims"),
      });
      closeDb(db);
      break;
    }
    case "import-doc": {
      const file = positional(0);
      if (!file) fail("usage: import-doc <file.json>");
      const db = openDb();
      const before = { documents: count("documents"), disclosures: count("document_disclosures") };
      const raw = readJson(file!);
      const docs = Array.isArray(raw) ? raw.map(validateDocument) : [validateDocument(raw)];
      for (const d of docs) {
        const res = importDocument(db, d);
        console.log(`document ${res.id} (${d.docNo}) ${res.created ? "imported" : "updated/unchanged"}`);
      }
      statusLine("documents", before, {
        documents: count("documents"),
        disclosures: count("document_disclosures"),
      });
      closeDb(db);
      break;
    }
    case "check-citations": {
      const file = opt("file");
      const appId = positional(0);
      let claims: ClaimInput[];
      if (file) {
        // raw structural check, bypasses import validation so defects are visible
        const raw = readJson(file) as { claims: ClaimInput[] };
        claims = raw.claims;
      } else if (appId) {
        const db = openDb();
        claims = getClaims(db, appId).map(rowToClaim);
        closeDb(db);
      } else {
        fail("usage: check-citations <appId> | --file <file.json>");
      }
      const issues = checkCitations(claims!);
      if (issues.length === 0) {
        console.log("citation check: OK (no cycles, no missing references)");
      } else {
        for (const i of issues) console.log(`  [${i.code}] claim ${i.claimNo}: ${i.detail}`);
        process.exitCode = 2;
      }
      break;
    }
    case "expand": {
      const appId = positional(0);
      if (!appId) fail("usage: expand <appId> [--limit N]");
      const db = openDb();
      const claims = getClaims(db, appId).map(rowToClaim);
      const limit = opt("limit") ? Number(opt("limit")) : DEFAULT_BRANCH_LIMIT;
      const { branches, issues } = expandClaims(claims, getMutexPairs(db, appId), limit);
      if (issues.length) {
        for (const i of issues) console.log(`  [${i.code}] claim ${i.claimNo}: ${i.detail}`);
      }
      console.log(`expanded ${branches.length} branch(es):`);
      for (const b of branches) {
        const tag = b.mutexConflict ? `  MUTEX(${b.conflictPair![0]} x ${b.conflictPair![1]})` : "";
        console.log(`  #${b.branchNo} root=${b.rootClaimNo} path=[${b.path.join("->")}] features=[${b.features.join(", ")}]${tag}`);
      }
      closeDb(db);
      break;
    }
    case "set-scope": {
      const appId = positional(0);
      const docs = opt("docs");
      if (!appId || !docs) fail("usage: set-scope <appId> --docs id1,id2,...");
      const db = openDb();
      const ids = docs.split(",").map((s) => s.trim());
      for (const id of ids) {
        if (!db.prepare("SELECT id FROM documents WHERE id=?").get(id)) fail(`document ${id} not found`);
      }
      db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)").run(`scope:${appId}`, JSON.stringify(ids));
      console.log(`scope for ${appId} set to ${ids.length} document(s): ${ids.join(", ")}`);
      closeDb(db);
      break;
    }
    case "analyze": {
      const appId = positional(0);
      if (!appId) fail("usage: analyze <appId> [--docs id1,id2,...]");
      const db = openDb();
      let scope: string[] | undefined;
      const docs = opt("docs");
      if (docs) {
        scope = docs.split(",").map((s) => s.trim());
      } else {
        const saved = db.prepare("SELECT value FROM schema_meta WHERE key=?").get(`scope:${appId}`) as
          | { value: string }
          | undefined;
        if (saved) scope = JSON.parse(saved.value);
      }
      const before = { analyses: count("analyses") };
      const res = createAnalysis(db, appId, scope);
      statusLine(`analysis ${res.summary.id} ${res.created ? "created" : "reused (idempotent)"}`, before, {
        analyses: count("analyses"),
      });
      console.log(
        `  branches=${res.summary.branchCount} docs=${res.summary.docCount} priorArt=${res.summary.priorArtCount} novelty=${res.summary.novelty}`,
      );
      if (res.reviewIssues.length) {
        console.log(`  pending review flags: ${res.reviewIssues.length}`);
        for (const f of res.reviewIssues) console.log(`    [${f.issueType}] ${f.subject}: ${f.detail}`);
      }
      closeDb(db);
      break;
    }
    case "analyses": {
      const appId = positional(0);
      const db = openDb();
      for (const s of listAnalyses(db, appId)) {
        console.log(
          `${s.id}  app=${s.appId} priority=${s.priorityDate} dict=${s.dictVersion} branches=${s.branchCount} novelty=${s.novelty}`,
        );
      }
      closeDb(db);
      break;
    }
    case "matrix": {
      const aid = positional(0);
      if (!aid) fail("usage: matrix <analysisId>");
      const db = openDb();
      const res = loadAnalysis(db, aid);
      const branchNos = [...new Set(res.coverage.map((c) => c.branchNo))].sort((a, b) => a - b);
      const docIds = [...new Set(res.coverage.map((c) => c.docId))];
      const docNo = new Map(res.coverage.map((c) => [c.docId, c.docNo]));
      console.log(`coverage matrix for ${aid} (structured coverage check; single-document rows only)`);
      console.log(`branch\\doc  ${docIds.map((d) => docNo.get(d)!.padEnd(14)).join("")}`);
      for (const b of branchNos) {
        const cells = docIds.map((d) => {
          const c = res.coverage.find((x) => x.branchNo === b && x.docId === d)!;
          const mark = !c.isPriorArt ? "-" : c.covered ? "COVERED" : `miss:${c.missing.length}`;
          return mark.padEnd(14);
        });
        console.log(`#${String(b).padEnd(10)}${cells.join("")}`);
      }
      closeDb(db);
      break;
    }
    case "coverage": {
      const aid = positional(0);
      if (!aid) fail("usage: coverage <analysisId> [--branch N]");
      const db = openDb();
      const res = loadAnalysis(db, aid);
      const branch = opt("branch") ? Number(opt("branch")) : undefined;
      for (const c of res.coverage.filter((x) => branch === undefined || x.branchNo === branch)) {
        console.log(`branch #${c.branchNo} vs ${c.docNo}: priorArt=${c.isPriorArt} covered=${c.covered}`);
        for (const item of c.items) {
          const ev = item.evidence ? ` evidence="${item.evidence}"` : "";
          const via = item.matchedFeature && item.matchedFeature !== item.feature ? ` via=${item.matchedFeature}` : "";
          console.log(`    ${item.feature}: ${item.status}${via}${ev}`);
        }
        if (c.missing.length) console.log(`    missing: ${c.missing.join(", ")}`);
      }
      closeDb(db);
      break;
    }
    case "flags": {
      const aid = positional(0);
      const db = openDb();
      const rows = listFlags(db, aid);
      for (const f of rows as Record<string, unknown>[]) {
        console.log(`${f.id}  [${f.issue_type}] ${f.subject} status=${f.status}  ${f.detail}`);
      }
      closeDb(db);
      break;
    }
    case "review": {
      const flagId = positional(0);
      const conclusion = opt("conclusion");
      const reviewer = opt("reviewer");
      const note = opt("note");
      if (!flagId || !conclusion || !reviewer) {
        fail("usage: review <flagId> --conclusion confirmed|rejected --reviewer NAME [--note TEXT]");
      }
      if (conclusion !== "confirmed" && conclusion !== "rejected") fail("conclusion must be confirmed|rejected");
      const db = openDb();
      reviewFlag(db, flagId, conclusion, reviewer, note);
      console.log(`flag ${flagId} reviewed: ${conclusion} by ${reviewer}`);
      closeDb(db);
      break;
    }
    case "export": {
      const aid = positional(0);
      const out = opt("out") ?? `data/report-${aid}.md`;
      if (!aid) fail("usage: export <analysisId> [--out file.md]");
      const db = openDb();
      const res = loadAnalysis(db, aid);
      const md = renderReport(db, res);
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), md, "utf8");
      console.log(`report written to ${out}`);
      closeDb(db);
      break;
    }
    case "demo": {
      const dbPath = resolve("data/demo.sqlite");
      if (existsSync(dbPath)) rmSync(dbPath);
      for (const suffix of ["-wal", "-shm"]) if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
      mkdirSync("data", { recursive: true });
      process.env.PATENT_DB_PATH = dbPath;
      const db = openDb(dbPath);
      console.log("== demo: import fixtures ==");
      const dict = validateDictVersion(readJson("fixtures/dict-v1.json"));
      importDictionary(db, dict.version, dict.equivalences);
      const app = validateApplication(readJson("fixtures/app-main.json"));
      const appRes = importApplication(db, app);
      console.log(`application ${appRes.id} imported (${app.claims.length} claims)`);
      const docs = (readJson("fixtures/documents.json") as unknown[]).map(validateDocument);
      for (const d of docs) importDocument(db, d);
      console.log(`${docs.length} fictional documents imported`);
      console.log("== demo: expand claims ==");
      const { branches } = expandClaims(app.claims, app.mutexPairs ?? []);
      console.log(`${branches.length} branches`);
      console.log("== demo: analyze ==");
      const res = createAnalysis(db, appRes.id);
      console.log(
        `analysis ${res.summary.id}: branches=${res.summary.branchCount} priorArt=${res.summary.priorArtCount} novelty=${res.summary.novelty}`,
      );
      const md = renderReport(db, loadAnalysis(db, res.summary.id));
      writeFileSync("data/demo-report.md", md, "utf8");
      console.log("report written to data/demo-report.md");
      closeDb(db);
      break;
    }
    case "serve": {
      const { startServer } = await import("../api/http.ts");
      const db = openDb();
      const { port } = await startServer(db);
      console.log(`listening on http://127.0.0.1:${port} (loopback only)`);
      break;
    }
    default:
      console.log(`patent-claim-matcher CLI
commands:
  import-dict <file.json>            import a versioned feature dictionary
  import-app <file.json>             import an application with claims
  import-doc <file.json>             import document(s) with disclosures
  check-citations <appId>|--file f   detect cycles / missing references
  expand <appId> [--limit N]         expand claims into inherited branches
  set-scope <appId> --docs ids       persist default comparison scope
  analyze <appId> [--docs ids]       run structured coverage check (idempotent)
  analyses [appId]                   list analyses
  matrix <analysisId>                show branch x document coverage matrix
  coverage <analysisId> [--branch N] show per-feature evidence and missing items
  flags [analysisId]                 list pending review flags
  review <flagId> --conclusion c --reviewer n [--note t]
  export <analysisId> [--out f.md]   export markdown report
  demo                               repeatable end-to-end demo with fixtures
  serve                              start the local API server (loopback, auto port)`);
  }
} catch (err) {
  if (err instanceof AppError) {
    console.error(`error [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
    process.exit(1);
  }
  throw err;
}
