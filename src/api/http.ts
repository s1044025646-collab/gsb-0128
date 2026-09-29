import type { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AppError, httpStatusFor } from "../errors.ts";
import { nowIso } from "../clock.ts";
import { importApplication, importDictionary, importDocument } from "../repository.ts";
import { createAnalysis, listAnalyses, loadAnalysis, listFlags, reviewFlag } from "../analysis.ts";
import { expandClaims } from "../expand.ts";
import { checkCitations } from "../expand.ts";
import { getApplicationOrThrow, getClaims, rowToClaim, getMutexPairs } from "../repository.ts";
import { validateApplication, validateDictVersion, validateDocument } from "../validation.ts";

interface RouteCtx {
  db: DatabaseSync;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (ctx: RouteCtx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    "^" +
      path.replace(/:([A-Za-z]+)/g, (_, k) => {
        keys.push(k);
        return "([^/]+)";
      }) +
      "$",
  );
  return { method, pattern, keys, handler };
}

function paginate<T>(rows: T[], query: URLSearchParams) {
  const limit = Math.min(Math.max(Number(query.get("limit") ?? "50"), 1), 200);
  const offset = Math.max(Number(query.get("offset") ?? "0"), 0);
  const slice = rows.slice(offset, offset + limit);
  return {
    data: slice,
    pagination: { limit, offset, total: rows.length, hasMore: offset + slice.length < rows.length },
  };
}

export function buildApp(db: DatabaseSync): Server {
  const routes: Route[] = [
    route("POST", "/api/dictionaries", ({ body }) => {
      const v = validateDictVersion(body);
      const res = importDictionary(db, v.version, v.equivalences);
      return { version: v.version, ...res };
    }),
    route("POST", "/api/applications", ({ body }) => {
      const app = validateApplication(body);
      const res = importApplication(db, app);
      return { id: res.id, created: res.created };
    }),
    route("GET", "/api/applications", ({ query }) => {
      const rows = db.prepare("SELECT * FROM applications ORDER BY created_at").all();
      return paginate(rows, query);
    }),
    route("GET", "/api/applications/:id", ({ params }) => {
      const app = getApplicationOrThrow(db, params.id!);
      const claims = getClaims(db, app.id).map(rowToClaim);
      return { ...app, claims, mutexPairs: getMutexPairs(db, app.id) };
    }),
    route("GET", "/api/applications/:id/citations", ({ params }) => {
      const app = getApplicationOrThrow(db, params.id!);
      const claims = getClaims(db, app.id).map(rowToClaim);
      return { issues: checkCitations(claims) };
    }),
    route("GET", "/api/applications/:id/expand", ({ params, query }) => {
      const app = getApplicationOrThrow(db, params.id!);
      const claims = getClaims(db, app.id).map(rowToClaim);
      const limit = query.get("limit_branches") ? Number(query.get("limit_branches")) : undefined;
      const result = expandClaims(claims, getMutexPairs(db, app.id), limit);
      return { issues: result.issues, ...paginate(result.branches, query) };
    }),
    route("POST", "/api/documents", ({ body }) => {
      const doc = validateDocument(body);
      const res = importDocument(db, doc);
      return { id: res.id, created: res.created };
    }),
    route("GET", "/api/documents", ({ query }) => {
      const rows = db.prepare("SELECT * FROM documents ORDER BY created_at").all();
      return paginate(rows, query);
    }),
    route("POST", "/api/applications/:id/analyses", ({ params, body }) => {
      const scope = (body as { scopeDocIds?: unknown } | null)?.scopeDocIds;
      if (scope !== undefined && (!Array.isArray(scope) || scope.some((s) => typeof s !== "string"))) {
        throw new AppError("VALIDATION_ERROR", "scopeDocIds must be an array of document ids");
      }
      const res = createAnalysis(db, params.id!, scope as string[] | undefined);
      return { ...res.summary, reviewIssues: res.reviewIssues, created: res.created };
    }),
    route("GET", "/api/applications/:id/analyses", ({ params, query }) => {
      const rows = listAnalyses(db, params.id!);
      return paginate(rows, query);
    }),
    route("GET", "/api/analyses/:aid", ({ params }) => loadAnalysis(db, params.aid!).summary),
    route("GET", "/api/analyses/:aid/coverage", ({ params, query }) => {
      const res = loadAnalysis(db, params.aid!);
      let rows = res.coverage;
      const branch = query.get("branch_no");
      if (branch !== null) rows = rows.filter((c) => c.branchNo === Number(branch));
      return paginate(rows, query);
    }),
    route("GET", "/api/analyses/:aid/matrix", ({ params }) => {
      const res = loadAnalysis(db, params.aid!);
      const branchNos = [...new Set(res.coverage.map((c) => c.branchNo))].sort((a, b) => a - b);
      const docIds = [...new Set(res.coverage.map((c) => c.docId))].sort();
      const cell = new Map(res.coverage.map((c) => [`${c.branchNo}|${c.docId}`, c]));
      return {
        analysisId: params.aid,
        note: "structured coverage check; each cell evaluates one branch against ONE document (no cross-document stitching)",
        documents: docIds.map((docId) => {
          const c0 = res.coverage.find((c) => c.docId === docId)!;
          return { docId, docNo: c0.docNo };
        }),
        matrix: branchNos.map((branchNo) => ({
          branchNo,
          cells: docIds.map((docId) => {
            const c = cell.get(`${branchNo}|${docId}`)!;
            return {
              docId,
              docNo: c.docNo,
              isPriorArt: c.isPriorArt,
              covered: c.covered,
              missing: c.missing,
            };
          }),
        })),
      };
    }),
    route("GET", "/api/analyses/:aid/flags", ({ params, query }) => {
      return paginate(listFlags(db, params.aid!, query.get("status") ?? undefined), query);
    }),
    route("POST", "/api/flags/:fid/review", ({ params, body }) => {
      const b = (body ?? {}) as { conclusion?: unknown; reviewer?: unknown; note?: unknown };
      if (b.conclusion !== "confirmed" && b.conclusion !== "rejected") {
        throw new AppError("VALIDATION_ERROR", "conclusion must be confirmed|rejected");
      }
      if (typeof b.reviewer !== "string" || b.reviewer.trim() === "") {
        throw new AppError("VALIDATION_ERROR", "reviewer must be a non-empty string");
      }
      if (b.note !== undefined && typeof b.note !== "string") {
        throw new AppError("VALIDATION_ERROR", "note must be a string");
      }
      reviewFlag(db, params.fid!, b.conclusion, b.reviewer, b.note as string | undefined);
      return { id: params.fid, status: b.conclusion };
    }),
    route("GET", "/api/health", () => ({ ok: true, time: nowIso() })),
  ];

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      let body: unknown = null;
      if (req.method === "POST" || req.method === "PUT") {
        body = await readJson(req);
      }
      // Idempotency for mutating requests: repeat with same key returns stored result.
      const idemKey = req.headers["idempotency-key"];
      if (typeof idemKey === "string" && idemKey && req.method !== "GET") {
        const cached = db.prepare("SELECT response FROM idempotency WHERE request_key=?").get(idemKey) as
          | { response: string }
          | undefined;
        if (cached) {
          sendJson(res, 200, { ...JSON.parse(cached.response), idempotent: true });
          return;
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.pattern);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]!])) as Record<string, string>;
          const result = await r.handler({ db, params, query: url.searchParams, body });
          const payload = JSON.stringify(result);
          db.prepare("INSERT OR REPLACE INTO idempotency(request_key,scope,response,created_at) VALUES(?,?,?,?)").run(
            idemKey,
            url.pathname,
            payload,
            nowIso(),
          );
          sendJson(res, 200, { ...JSON.parse(payload), idempotent: false });
          return;
        }
      }

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]!])) as Record<string, string>;
        const result = await r.handler({ db, params, query: url.searchParams, body });
        sendJson(res, 200, result);
        return;
      }
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: `no route for ${req.method} ${url.pathname}` } });
    } catch (err) {
      if (err instanceof AppError) {
        sendJson(res, httpStatusFor(err.code), { error: { code: err.code, message: err.message, details: err.details } });
      } else if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: { code: "VALIDATION_ERROR", message: "invalid JSON body" } });
      } else {
        sendJson(res, 500, { error: { code: "INTERNAL", message: (err as Error).message } });
      }
    }
  }

  return server;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) {
        reject(new AppError("VALIDATION_ERROR", "request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data ? JSON.parse(data) : null));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

/** Start bound to loopback only, on an ephemeral port (or PATENT_PORT). */
export function startServer(db: DatabaseSync): Promise<{ server: Server; port: number }> {
  const server = buildApp(db);
  const port = Number(process.env.PATENT_PORT ?? "0");
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("unexpected address");
      resolve({ server, port: addr.port });
    });
  });
}
