import * as http from 'node:http';
import { Store } from './store';
import { validateTree, MAX_NODES, MAX_LABEL_LENGTH } from './validate';
import { morrisTraverse, DEFAULT_MAX_STEPS } from './morris';
import { TraversalOrder, TreeInput } from './types';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      // GET /health
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, limits: { maxNodes: MAX_NODES, maxLabelLength: MAX_LABEL_LENGTH } });
      }

      // POST /trees/validate  { rootId, nodes }
      if (req.method === 'POST' && url.pathname === '/trees/validate') {
        const body = (await readBody(req)) as TreeInput;
        return sendJson(res, 200, validateTree(body));
      }

      // POST /trees  { name?, rootId, nodes }
      if (req.method === 'POST' && url.pathname === '/trees') {
        const body = (await readBody(req)) as TreeInput & { name?: string };
        const validation = validateTree(body);
        if (!validation.ok) return sendJson(res, 422, { error: 'VALIDATION_FAILED', details: validation.errors });
        const record = store.importTree(body, body.name ?? 'default');
        return sendJson(res, 201, { treeId: record.id, name: record.name, version: record.version, hash: record.hash });
      }

      // GET /trees  / GET /trees/:id
      if (req.method === 'GET' && parts[0] === 'trees' && parts.length === 1) {
        return sendJson(res, 200, store.listTrees().map((t) => ({ treeId: t.id, name: t.name, version: t.version, hash: t.hash, createdAt: t.createdAt })));
      }
      if (req.method === 'GET' && parts[0] === 'trees' && parts.length === 2) {
        const tree = store.getTree(Number(parts[1]));
        if (!tree) return sendJson(res, 404, { error: 'TREE_NOT_FOUND' });
        return sendJson(res, 200, { treeId: tree.id, name: tree.name, version: tree.version, hash: tree.hash, tree: tree.payload, createdAt: tree.createdAt });
      }

      // POST /runs  { treeId, order, maxSteps? }
      if (req.method === 'POST' && url.pathname === '/runs') {
        const body = (await readBody(req)) as { treeId?: number; order?: string; maxSteps?: number };
        const tree = store.getTree(Number(body.treeId));
        if (!tree) return sendJson(res, 404, { error: 'TREE_NOT_FOUND' });
        if (body.order !== 'inorder' && body.order !== 'preorder') {
          return sendJson(res, 400, { error: 'BAD_ORDER', message: "order 必须是 'inorder' 或 'preorder'" });
        }
        const maxSteps = body.maxSteps === undefined ? DEFAULT_MAX_STEPS : Math.max(0, Math.floor(Number(body.maxSteps)));
        if (!Number.isFinite(maxSteps)) return sendJson(res, 400, { error: 'BAD_MAX_STEPS' });
        const result = morrisTraverse(tree.payload, body.order as TraversalOrder, maxSteps);
        const run = store.saveRun(tree, result);
        return sendJson(res, 201, {
          runId: run.id,
          treeId: tree.id,
          treeVersion: tree.version,
          order: run.order,
          algorithmVersion: run.algorithmVersion,
          sequence: run.sequence,
          labels: run.labels,
          totalSteps: run.totalSteps,
          stepsTruncated: run.stepsTruncated,
          structureRestored: run.structureRestored,
        });
      }

      // GET /runs  / GET /runs/:id
      if (req.method === 'GET' && parts[0] === 'runs' && parts.length === 1) {
        const treeId = url.searchParams.get('treeId');
        const runs = store.listRuns(treeId === null ? undefined : Number(treeId));
        return sendJson(res, 200, runs.map((r) => ({ runId: r.id, treeId: r.treeId, treeVersion: r.treeVersion, order: r.order, algorithmVersion: r.algorithmVersion, totalSteps: r.totalSteps, stepsTruncated: r.stepsTruncated, structureRestored: r.structureRestored, createdAt: r.createdAt })));
      }
      if (req.method === 'GET' && parts[0] === 'runs' && parts.length >= 2) {
        const run = store.getRun(Number(parts[1]));
        if (!run) return sendJson(res, 404, { error: 'RUN_NOT_FOUND' });
        if (parts.length === 2) {
          return sendJson(res, 200, { ...run, steps: undefined, stepsReturned: run.steps.length });
        }
        // GET /runs/:id/steps/:seq
        if (parts[2] === 'steps' && parts.length === 4) {
          const seq = Number(parts[3]);
          const step = (run.steps as { seq: number }[]).find((s) => s.seq === seq);
          if (!step) {
            return sendJson(res, 404, { error: 'STEP_NOT_FOUND', message: run.stepsTruncated ? '该步骤超出已保存的解释范围（日志已截短）' : '步骤序号不存在' });
          }
          return sendJson(res, 200, step);
        }
        // GET /runs/:id/verify
        if (parts[2] === 'verify' && parts.length === 3) {
          const tree = store.getTree(run.treeId);
          if (!tree) return sendJson(res, 404, { error: 'TREE_NOT_FOUND' });
          const validation = validateTree(tree.payload);
          return sendJson(res, 200, {
            runId: run.id,
            structureRestored: run.structureRestored,
            storedTreeStillValid: validation.ok,
            nodeCount: tree.payload.nodes.length,
            visitedCount: run.sequence.length,
            eachNodeVisitedOnce: new Set(run.sequence).size === run.sequence.length && run.sequence.length === tree.payload.nodes.length,
          });
        }
        // GET /runs/:id/report
        if (parts[2] === 'report' && parts.length === 3) {
          const tree = store.getTree(run.treeId);
          return sendJson(res, 200, { run, tree: tree?.payload });
        }
      }

      // POST /compare  { treeId, maxSteps? } — 同树两种次序对比
      if (req.method === 'POST' && url.pathname === '/compare') {
        const body = (await readBody(req)) as { treeId?: number; maxSteps?: number };
        const tree = store.getTree(Number(body.treeId));
        if (!tree) return sendJson(res, 404, { error: 'TREE_NOT_FOUND' });
        const maxSteps = body.maxSteps === undefined ? DEFAULT_MAX_STEPS : Math.max(0, Math.floor(Number(body.maxSteps)));
        const inorder = store.saveRun(tree, morrisTraverse(tree.payload, 'inorder', maxSteps));
        const preorder = store.saveRun(tree, morrisTraverse(tree.payload, 'preorder', maxSteps));
        return sendJson(res, 201, {
          treeId: tree.id,
          inorder: { runId: inorder.id, sequence: inorder.sequence, labels: inorder.labels },
          preorder: { runId: preorder.id, sequence: preorder.sequence, labels: preorder.labels },
          sameNodeSet: JSON.stringify([...inorder.sequence].sort((a, b) => a - b)) === JSON.stringify([...preorder.sequence].sort((a, b) => a - b)),
        });
      }

      return sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'BAD_JSON') return sendJson(res, 400, { error: 'BAD_JSON' });
      if (message === 'PAYLOAD_TOO_LARGE') return sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      if (message.startsWith('INTERNAL_RESTORE_FAILURE')) return sendJson(res, 500, { error: 'INTERNAL_RESTORE_FAILURE', message: '结构恢复自检失败，未发布完成报告' });
      return sendJson(res, 500, { error: 'INTERNAL', message });
    }
  });
}
