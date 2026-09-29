import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { tempDb, seedMainApp } from "./helpers.ts";
import { startServer } from "../src/api/http.ts";
import type { DatabaseSync } from "node:sqlite";

let server: Server;
let base: string;
let db: ReturnType<typeof tempDb>["db"];
let cleanup: () => void;

before(async () => {
  const env = tempDb();
  db = env.db;
  cleanup = env.cleanup;
  const started = await startServer(db);
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  cleanup();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as unknown;
  return { status: res.status, json };
}

test("health endpoint", async () => {
  const { status, json } = await call("GET", "/api/health");
  assert.equal(status, 200);
  assert.equal((json as { ok: boolean }).ok, true);
});

test("validation error returns 400 with explicit error code", async () => {
  const { status, json } = await call("POST", "/api/applications", { title: "" });
  assert.equal(status, 400);
  assert.equal((json as { error: { code: string } }).error.code, "VALIDATION_ERROR");
});

test("unknown resource returns 404", async () => {
  const { status } = await call("GET", "/api/applications/app_nope");
  assert.equal(status, 404);
});

test("citation defects return 422 at analysis time", async () => {
  // cyclic claims cannot pass strict import validation; seed directly to exercise the path
  db.exec(
    `INSERT INTO dictionaries(version,created_at) VALUES('dict-vcyc','2020-01-01');
     INSERT INTO applications(id,title,filing_date,priority_date,dict_version,created_at)
       VALUES('app-cycle','x','2021-01-01','2020-01-01','dict-vcyc','2020-01-01');
     INSERT INTO claims(id,app_id,claim_no,kind,dep_type,depends_on,features,seq,created_at) VALUES
       ('c1','app-cycle',1,'independent','none','[]','[]',0,'2020-01-01'),
       ('c2','app-cycle',2,'dependent','any','[3]','[]',1,'2020-01-01'),
       ('c3','app-cycle',3,'dependent','any','[2]','[]',2,'2020-01-01');`,
  );
  const { status, json } = await call("POST", "/api/applications/app-cycle/analyses", {});
  assert.equal(status, 422);
  assert.equal((json as { error: { code: string } }).error.code, "CYCLIC_REF");
});

test("full workflow through API with pagination and idempotency", async () => {
  const appId = seedMainApp(db);
  const { status, json } = await call("POST", `/api/applications/${appId}/analyses`, {}, {
    "idempotency-key": "key-123",
  });
  assert.equal(status, 200);
  const id = (json as { id: string }).id;
  // replay
  const replay = await call("POST", `/api/applications/${appId}/analyses`, {}, { "idempotency-key": "key-123" });
  assert.equal((replay.json as { idempotent: boolean }).idempotent, true);
  // matrix
  const matrix = await call("GET", `/api/analyses/${id}/matrix`);
  assert.equal(matrix.status, 200);
  assert.ok(Array.isArray((matrix.json as { matrix: unknown[] }).matrix));
  // pagination
  const page = await call("GET", `/api/analyses/${id}/coverage?limit=2&offset=0`);
  assert.equal((page.json as { pagination: { limit: number; total: number } }).pagination.limit, 2);
  assert.ok((page.json as { pagination: { total: number } }).pagination.total > 2);
  assert.equal((page.json as { data: unknown[] }).data.length, 2);
  // flags and review
  const flags = await call("GET", `/api/analyses/${id}/flags`);
  const firstFlag = (flags.json as { data: { id: string }[] }).data[0];
  if (firstFlag) {
    const reviewed = await call("POST", `/api/flags/${firstFlag.id}/review`, {
      conclusion: "confirmed",
      reviewer: "tester",
    });
    assert.equal(reviewed.status, 200);
    const bad = await call("POST", `/api/flags/${firstFlag.id}/review`, { conclusion: "x", reviewer: "t" });
    assert.equal(bad.status, 400);
  }
});
