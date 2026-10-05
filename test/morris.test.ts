import { test } from 'node:test';
import assert from 'node:assert/strict';
import { morrisTraverse } from '../src/morris';
import { validateTree } from '../src/validate';
import { TreeInput } from '../src/types';

// 独立递归基准，仅用于测试核对
function recursive(tree: TreeInput, order: 'inorder' | 'preorder'): number[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const out: number[] = [];
  const walk = (id: number | null): void => {
    if (id === null) return;
    const n = byId.get(id)!;
    if (order === 'preorder') out.push(n.id);
    walk(n.left ?? null);
    if (order === 'inorder') out.push(n.id);
    walk(n.right ?? null);
  };
  walk(tree.rootId ?? null);
  return out;
}

const DEMO: TreeInput = {
  rootId: 2,
  nodes: [
    { id: 2, label: 'B', left: 1, right: 4 },
    { id: 1, label: 'A', left: null, right: null },
    { id: 4, label: 'D', left: 3, right: null },
    { id: 3, label: 'C', left: null, right: null },
  ],
};

test('演示树：中序 A B C D，前序 B A D C', () => {
  const inorder = morrisTraverse(DEMO, 'inorder');
  const preorder = morrisTraverse(DEMO, 'preorder');
  assert.deepEqual(inorder.labels, ['A', 'B', 'C', 'D']);
  assert.deepEqual(preorder.labels, ['B', 'A', 'D', 'C']);
  assert.ok(inorder.structureRestored && preorder.structureRestored);
});

test('演示树：前驱 A 到 B 的临时线索被建立并拆除', () => {
  const { steps } = morrisTraverse(DEMO, 'inorder');
  const link = steps.find((s) => s.type === 'link' && s.predecessor === 1);
  const unlink = steps.find((s) => s.type === 'unlink' && s.predecessor === 1);
  assert.ok(link && unlink);
  assert.deepEqual(link.edge, { node: 1, field: 'right', oldValue: null, newValue: 2, isOriginalEdge: false });
  assert.deepEqual(unlink!.edge, { node: 1, field: 'right', oldValue: 2, newValue: null, isOriginalEdge: false });
});

test('空树合法，序列为空', () => {
  const empty: TreeInput = { rootId: null, nodes: [] };
  assert.ok(validateTree(empty).ok);
  const r = morrisTraverse(empty, 'inorder');
  assert.deepEqual(r.sequence, []);
  assert.ok(r.structureRestored);
});

test('单节点', () => {
  const t: TreeInput = { rootId: 7, nodes: [{ id: 7, label: 'x', left: null, right: null }] };
  assert.deepEqual(morrisTraverse(t, 'inorder').sequence, [7]);
  assert.deepEqual(morrisTraverse(t, 'preorder').sequence, [7]);
});

test('只有左链 / 只有右链', () => {
  const left: TreeInput = {
    rootId: 1,
    nodes: [
      { id: 1, label: 'a', left: 2, right: null },
      { id: 2, label: 'b', left: 3, right: null },
      { id: 3, label: 'c', left: null, right: null },
    ],
  };
  const right: TreeInput = {
    rootId: 1,
    nodes: [
      { id: 1, label: 'a', left: null, right: 2 },
      { id: 2, label: 'b', left: null, right: 3 },
      { id: 3, label: 'c', left: null, right: null },
    ],
  };
  for (const t of [left, right]) {
    for (const order of ['inorder', 'preorder'] as const) {
      const r = morrisTraverse(t, order);
      assert.deepEqual(r.sequence, recursive(t, order));
      assert.ok(r.structureRestored);
    }
  }
  assert.deepEqual(morrisTraverse(left, 'inorder').sequence, [3, 2, 1]);
  assert.deepEqual(morrisTraverse(right, 'inorder').sequence, [1, 2, 3]);
});

test('重复标签允许', () => {
  const t: TreeInput = {
    rootId: 1,
    nodes: [
      { id: 1, label: 'same', left: 2, right: 3 },
      { id: 2, label: 'same', left: null, right: null },
      { id: 3, label: 'same', left: null, right: null },
    ],
  };
  assert.ok(validateTree(t).ok);
  assert.deepEqual(morrisTraverse(t, 'inorder').labels, ['same', 'same', 'same']);
});

test('交错子树与递归基准一致（随机小样本）', () => {
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let trial = 0; trial < 50; trial++) {
    const n = 1 + Math.floor(rand() * 12);
    const nodes = Array.from({ length: n }, (_, i) => ({ id: i + 1, label: `n${i}`, left: null as number | null, right: null as number | null }));
    for (let i = 1; i < n; i++) {
      const parent = Math.floor(rand() * i);
      const field = rand() < 0.5 ? 'left' : 'right';
      if (nodes[parent][field] === null) nodes[parent][field] = i + 1;
      else if (nodes[parent][field === 'left' ? 'right' : 'left'] === null) nodes[parent][field === 'left' ? 'right' : 'left'] = i + 1;
      else { i--; continue; }
    }
    const tree: TreeInput = { rootId: 1, nodes };
    assert.ok(validateTree(tree).ok, `trial ${trial} 应合法`);
    for (const order of ['inorder', 'preorder'] as const) {
      const r = morrisTraverse(tree, order);
      assert.deepEqual(r.sequence, recursive(tree, order), `trial ${trial} ${order}`);
      assert.ok(r.structureRestored);
    }
  }
});

test('解释截短不提前结束遍历', () => {
  const r = morrisTraverse(DEMO, 'inorder', 3);
  assert.equal(r.steps.length, 3);
  assert.ok(r.stepsTruncated);
  assert.ok(r.totalSteps > 3);
  assert.deepEqual(r.labels, ['A', 'B', 'C', 'D']);
  assert.ok(r.structureRestored);
});

test('非法输入：共享子节点 / 环 / 自环 / 未知引用 / 多根 / 重复编号', () => {
  const shared: TreeInput = {
    rootId: 1,
    nodes: [
      { id: 1, label: 'a', left: 2, right: 3 },
      { id: 2, label: 'b', left: 4, right: null },
      { id: 3, label: 'c', left: 4, right: null },
      { id: 4, label: 'd', left: null, right: null },
    ],
  };
  assert.ok(validateTree(shared).errors.some((e) => e.code === 'MULTIPLE_PARENTS'));

  const cycle: TreeInput = {
    rootId: 1,
    nodes: [
      { id: 1, label: 'a', left: 2, right: null },
      { id: 2, label: 'b', left: 3, right: null },
      { id: 3, label: 'c', left: 2, right: null },
    ],
  };
  const cycleResult = validateTree(cycle);
  assert.ok(!cycleResult.ok);
  assert.ok(cycleResult.errors.some((e) => e.code === 'CYCLE' || e.code === 'MULTIPLE_PARENTS'));

  const selfLoop: TreeInput = { rootId: 1, nodes: [{ id: 1, label: 'a', left: 1, right: null }] };
  assert.ok(validateTree(selfLoop).errors.some((e) => e.code === 'SELF_LOOP'));

  const unknownRef: TreeInput = { rootId: 1, nodes: [{ id: 1, label: 'a', left: 99, right: null }] };
  assert.ok(validateTree(unknownRef).errors.some((e) => e.code === 'UNKNOWN_REF'));

  const forest: TreeInput = {
    rootId: 1,
    nodes: [
      { id: 1, label: 'a', left: null, right: null },
      { id: 2, label: 'b', left: null, right: null },
    ],
  };
  assert.ok(validateTree(forest).errors.some((e) => e.code === 'MULTIPLE_ROOTS'));

  const dup: TreeInput = {
    rootId: 1,
    nodes: [
      { id: 1, label: 'a', left: null, right: null },
      { id: 1, label: 'b', left: null, right: null },
    ],
  };
  assert.ok(validateTree(dup).errors.some((e) => e.code === 'DUPLICATE_ID'));
});
