import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { MorrisServiceError } from "./types.js";
import { MorrisStore } from "./db.js";

interface RouteContext {
  store: MorrisStore;
  body: unknown;
  params: Map<string, string>;
  query: URLSearchParams;
}

type RouteHandler = (context: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  pattern: string;
  keys: string[];
  matcher: RegExp;
  handler: RouteHandler;
}

export function createApp(store: MorrisStore): Server {
  const routes: Route[] = [
    route("GET", "/health", () => ({ ok: true })),
    route("GET", "/trees", ({ store: db }) => ({ trees: db.listTrees() })),
    route("POST", "/trees", ({ store: db, body }) => db.importTree(body)),
    route(
      "POST",
      "/trees/:treeId/versions",
      ({ store: db, body, params }) =>
        db.importTree(body, integerParam(params, "treeId"))
    ),
    route("GET", "/trees/:treeId", ({ store: db, params, query }) =>
      db.getTreeVersion(
        integerParam(params, "treeId"),
        optionalIntegerQuery(query, "version")
      )
    ),
    route("POST", "/trees/:treeId/validate", ({ store: db, params, query }) =>
      db.validateTree(
        integerParam(params, "treeId"),
        optionalIntegerQuery(query, "version")
      )
    ),
    route("POST", "/trees/:treeId/runs/:mode", ({ store: db, params, query }) => {
      const mode = parseMode(params.get("mode") ?? null);
      return db.runAndSave(
        integerParam(params, "treeId"),
        mode,
        optionalIntegerQuery(query, "version")
      ).run;
    }),
    route("GET", "/runs", ({ store: db, query }) => ({
      runs: db.listRuns(optionalIntegerQuery(query, "treeId"))
    })),
    route("GET", "/runs/:runId", ({ store: db, params }) => {
      const run = db.getRun(integerParam(params, "runId"));
      return { run, result: db.resultFromRun(run) };
    }),
    route("GET", "/runs/:runId/order", ({ store: db, params }) => {
      const run = db.getRun(integerParam(params, "runId"));
      return { runId: run.id, mode: run.mode, order: db.resultFromRun(run).order };
    }),
    route("GET", "/runs/:runId/steps/:stepIndex", ({ store: db, params }) =>
      db.getStep(
        integerParam(params, "runId"),
        integerParam(params, "stepIndex")
      )
    ),
    route("GET", "/runs/:runId/verify", ({ store: db, params }) =>
      db.verifyRestoration(integerParam(params, "runId"))
    ),
    route(
      "GET",
      "/runs/:firstRunId/compare/:secondRunId",
      ({ store: db, params }) =>
        db.compareRuns(
          integerParam(params, "firstRunId"),
          integerParam(params, "secondRunId")
        )
    ),
    route("GET", "/runs/:runId/report", ({ store: db, params, query }) =>
      db.exportReport(
        integerParam(params, "runId"),
        optionalIntegerQuery(query, "maxSteps")
      )
    )
  ];

  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    await handleRequest(request, response, store, routes);
  });
}

export async function listenOnFreePort(
  server: Server,
  configuredPort?: number
): Promise<number> {
  const port = configuredPort ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function route(method: string, pattern: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  const expression = pattern
    .split(/(:[A-Za-z][A-Za-z0-9]*)/g)
    .map((part) => {
      if (part.startsWith(":")) {
        keys.push(part.slice(1));
        return "([^/]+)";
      }
      return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return {
    method,
    pattern,
    keys,
    matcher: new RegExp(`^${expression}$`),
    handler
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  store: MorrisStore,
  routes: Route[]
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const match = findRoute(routes, request.method ?? "GET", url.pathname);
    if (!match) {
      sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "接口不存在" }
      });
      return;
    }

    const body = await readJsonBody(request);
    const result = await match.route.handler({
      store,
      body,
      params: match.params,
      query: url.searchParams
    });
    sendJson(response, 200, result);
  } catch (error) {
    if (error instanceof MorrisServiceError) {
      sendJson(response, statusForCode(error.code), {
        error: { code: error.code, message: error.message, details: error.details }
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, {
      error: { code: "INTERNAL_INVARIANT_FAILED", message }
    });
  }
}

function findRoute(
  routes: Route[],
  method: string,
  pathname: string
): { route: Route; params: Map<string, string> } | null {
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = candidate.matcher.exec(pathname);
    if (!match) continue;
    const params = new Map<string, string>();
    candidate.keys.forEach((key, index) => params.set(key, decodeURIComponent(match[index + 1])));
    return { route: candidate, params };
  }
  return null;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 2_000_000) {
      throw new MorrisServiceError("INVALID_ARGUMENT", "请求体超过 2 MB 限制");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MorrisServiceError("INVALID_ARGUMENT", "请求体不是合法 JSON");
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function parseMode(value: string | null): "inorder" | "preorder" {
  if (value === "inorder" || value === "preorder") return value;
  throw new MorrisServiceError(
    "INVALID_ARGUMENT",
    "遍历方式必须是 inorder 或 preorder",
    { value }
  );
}

function integerParam(params: Map<string, string>, key: string): number {
  return parseInteger(params.get(key), key);
}

function optionalIntegerQuery(query: URLSearchParams, key: string): number | undefined {
  const value = query.get(key);
  if (value === null) return undefined;
  return parseInteger(value, key);
}

function parseInteger(value: string | null | undefined, key: string): number {
  if (value === undefined || value === null || !/^-?\d+$/.test(value)) {
    throw new MorrisServiceError("INVALID_ARGUMENT", `${key} 必须是整数`, { value });
  }
  return Number(value);
}

function statusForCode(code: string): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "INTERNAL_INVARIANT_FAILED") return 500;
  return 400;
}
