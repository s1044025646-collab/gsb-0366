import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../src/store';
import { createServer } from '../src/server';
import { morrisTraverse } from '../src/morris';
import { TreeInput } from '../src/types';

const DEMO: TreeInput = {
  rootId: 2,
  nodes: [
    { id: 2, label: 'B', left: 1, right: 4 },
    { id: 1, label: 'A', left: null, right: null },
    { id: 4, label: 'D', left: 3, right: null },
    { id: 3, label: 'C', left: null, right: null },
  ],
};

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'morris-')), 'test.db');
}

test('存储：导入不可变版本，改标签产生新版本，重启后可读', () => {
  const db = tmpDb();
  let store = new Store(db);
  const t1 = store.importTree(DEMO, 'demo');
  const t1again = store.importTree(DEMO, 'demo');
  assert.equal(t1again.id, t1.id, '相同内容复用同一版本');
  const modified: TreeInput = { ...DEMO, nodes: DEMO.nodes.map((n) => (n.id === 1 ? { ...n, label: 'A2' } : n)) };
  const t2 = store.importTree(modified, 'demo');
  assert.equal(t2.version, t1.version + 1);
  const run = store.saveRun(t1, morrisTraverse(t1.payload, 'inorder'));
  store.close();

  // 模拟重启
  store = new Store(db);
  const runReloaded = store.getRun(run.id)!;
  assert.deepEqual(runReloaded.sequence, [1, 2, 3, 4]);
  assert.equal(runReloaded.treeVersion, t1.version);
  const oldTree = store.getTree(t1.id)!;
  assert.equal(oldTree.payload.nodes.find((n) => n.id === 1)!.label, 'A', '旧版本报告仍能定位旧节点');
  store.close();
});

test('API：导入/运行/查步骤/核验/对比/错误码', async () => {
  const store = new Store(tmpDb());
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (p: string, body: unknown) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const bad = await post('/trees', { rootId: 1, nodes: [{ id: 1, label: 'a', left: 1, right: null }] });
  assert.equal(bad.status, 422);
  assert.equal((bad.body.details as { code: string }[])[0].code, 'SELF_LOOP');

  const imported = await post('/trees', { name: 'demo', ...DEMO });
  assert.equal(imported.status, 201);
  const treeId = imported.body.treeId as number;

  const run = await post('/runs', { treeId, order: 'inorder' });
  assert.equal(run.status, 201);
  assert.deepEqual(run.body.labels, ['A', 'B', 'C', 'D']);
  const runId = run.body.runId as number;

  const badOrder = await post('/runs', { treeId, order: 'sideways' });
  assert.equal(badOrder.status, 400);
  assert.equal(badOrder.body.error, 'BAD_ORDER');

  const stepRes = await fetch(`${base}/runs/${runId}/steps/1`);
  assert.equal(stepRes.status, 200);
  const step = (await stepRes.json()) as { seq: number; type: string };
  assert.equal(step.seq, 1);

  const verify = await (await fetch(`${base}/runs/${runId}/verify`)).json() as Record<string, unknown>;
  assert.equal(verify.structureRestored, true);
  assert.equal(verify.eachNodeVisitedOnce, true);

  const compare = await post('/compare', { treeId });
  assert.equal(compare.status, 201);
  assert.deepEqual((compare.body.inorder as { labels: string[] }).labels, ['A', 'B', 'C', 'D']);
  assert.deepEqual((compare.body.preorder as { labels: string[] }).labels, ['B', 'A', 'D', 'C']);

  const missing = await fetch(`${base}/runs/9999`);
  assert.equal(missing.status, 404);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

test('截短运行保存后，超出范围的步骤查询返回明确错误', async () => {
  const store = new Store(tmpDb());
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const post = async (p: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const imported = await post('/trees', { ...DEMO });
  const run = await post('/runs', { treeId: imported.body.treeId, order: 'preorder', maxSteps: 2 });
  assert.equal(run.body.stepsTruncated, true);
  assert.deepEqual(run.body.labels, ['B', 'A', 'D', 'C'], '截短不影响完整遍历');
  const res = await fetch(`http://127.0.0.1:${port}/runs/${run.body.runId}/steps/999`);
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { error: string }).error, 'STEP_NOT_FOUND');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});
