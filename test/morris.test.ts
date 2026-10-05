import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MorrisStore } from "../src/db.js";
import { runMorris, truncateResult } from "../src/morris.js";
import { validateTree } from "../src/validation.js";
import { edgeReferences, recursiveInorder, recursivePreorder } from "../src/reference.js";
import { TreeInput } from "../src/types.js";
import { MorrisServiceError } from "../src/types.js";

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof MorrisServiceError && error.code === code;
}

const demo: TreeInput = {
  rootId: "B",
  nodes: [
    { id: "B", label: "B", left: "A", right: "D" },
    { id: "A", label: "A" },
    { id: "D", label: "D", left: "C" },
    { id: "C", label: "C" }
  ]
};

const cases: Array<[string, TreeInput]> = [
  ["空树", { rootId: null, nodes: [] }],
  ["单节点", { rootId: "x", nodes: [{ id: "x", label: "X" }] }],
  ["只有左链", {
    rootId: "a",
    nodes: [
      { id: "a", label: "A", left: "b" },
      { id: "b", label: "重复", left: "c" },
      { id: "c", label: "重复" }
    ]
  }],
  ["只有右链", {
    rootId: "a",
    nodes: [
      { id: "a", label: "A", right: "b" },
      { id: "b", label: "B", right: "c" },
      { id: "c", label: "C" }
    ]
  }],
  ["重复标签和交错子树", {
    rootId: "1",
    nodes: [
      { id: "1", label: "X", left: "2", right: "3" },
      { id: "2", label: "Y", right: "4" },
      { id: "3", label: "X", left: "5" },
      { id: "4", label: "X" },
      { id: "5", label: "Y" }
    ]
  }]
];

const allCases: Array<[string, TreeInput]> = [["演示树", demo], ...cases];

for (const [name, input] of allCases) {
  test(`${name}：两种顺序与独立递归基准一致且结构恢复`, () => {
    const validated = validateTree(input);
    for (const mode of ["inorder", "preorder"] as const) {
      const result = runMorris(validated, mode);
      const expected = mode === "inorder" ? recursiveInorder(input) : recursivePreorder(input);
      assert.deepEqual(result.order, expected);
      assert.equal(new Set(result.order).size, result.order.length);
      assert.equal(result.order.length, input.nodes.length);
      assert.equal(result.temporaryThreadsCreated, result.temporaryThreadsRemoved);
      assert.equal(result.structureRestored, true);
      assert.deepEqual(result.afterEdges, edgeReferences(input));
      assert.deepEqual([...new Set(result.steps.map((step) => step.index))], result.steps.map((step) => step.index));
    }
  });
}

test("演示树中序为 A B C D，前序为 B A D C，并记录 A 到 B 线索拆除", () => {
  const result = runMorris(validateTree(demo), "inorder");
  assert.deepEqual(result.order, ["A", "B", "C", "D"]);
  const preorder = runMorris(validateTree(demo), "preorder");
  assert.deepEqual(preorder.order, ["B", "A", "D", "C"]);
  const create = result.steps.find((step) => step.kind === "thread-create");
  const remove = result.steps.find((step) => step.kind === "thread-remove");
  assert.deepEqual(create?.pointer, { side: "right", oldValue: null, newValue: "B" });
  assert.equal(create?.predecessor, "A");
  assert.deepEqual(remove?.pointer, { side: "right", oldValue: "B", newValue: null });
});

test("解释截断只影响展示，不提前结束计算，也不留临时边", () => {
  const result = runMorris(validateTree(demo), "inorder");
  const view = truncateResult(result, { maxSteps: 3 });
  assert.equal(view.truncated, true);
  assert.equal(view.steps.length, 3);
  assert.equal(view.totalSteps, result.steps.length);
  assert.equal(result.temporaryThreadsCreated, result.temporaryThreadsRemoved);
  assert.deepEqual(result.afterEdges, edgeReferences(demo));
});

test("拒绝共享子节点、循环、未知引用、自环、多根和不可达节点", () => {
  const shared: TreeInput = {
    rootId: "r",
    nodes: [
      { id: "r", label: "R", left: "a", right: "b" },
      { id: "a", label: "A", right: "c" },
      { id: "b", label: "B", left: "c" },
      { id: "c", label: "C" }
    ]
  };
  assert.throws(() => validateTree(shared), expectCode("DUPLICATE_PARENT"));

  const cyclic = {
    rootId: "r",
    nodes: [
      { id: "r", label: "R", left: "a" },
      { id: "a", label: "A", right: "r" }
    ]
  };
  assert.throws(() => validateTree(cyclic), expectCode("CYCLE_DETECTED"));

  const unknown: TreeInput = { rootId: "r", nodes: [{ id: "r", label: "R", left: "x" }] };
  assert.throws(() => validateTree(unknown), expectCode("UNKNOWN_REFERENCE"));

  const self: TreeInput = { rootId: "r", nodes: [{ id: "r", label: "R", right: "r" }] };
  assert.throws(() => validateTree(self), expectCode("SELF_REFERENCE"));

  const disconnected: TreeInput = {
    rootId: "r",
    nodes: [{ id: "r", label: "R" }, { id: "x", label: "X" }]
  };
  assert.throws(
    () => validateTree(disconnected),
    (error: unknown) =>
      error instanceof MorrisServiceError &&
      (error.code === "UNREACHABLE_NODE" || error.code === "MULTIPLE_ROOTS")
  );
});

test("SQLite 原子保存、新版本和重启后查询", () => {
  const directory = mkdtempSync(join(tmpdir(), "morris-sqlite-"));
  const dbPath = join(directory, "morris.sqlite");
  try {
    let store = new MorrisStore(dbPath);
    const tree = store.importTree(demo);
    const inorder = store.runAndSave(tree.tree_id, "inorder", tree.version).run;
    const preorder = store.runAndSave(tree.tree_id, "preorder", tree.version).run;
    assert.deepEqual(JSON.parse(inorder.order_json), ["A", "B", "C", "D"]);
    assert.deepEqual(JSON.parse(preorder.order_json), ["B", "A", "D", "C"]);

    const changed: TreeInput = {
      ...demo,
      nodes: demo.nodes.map((node) =>
        node.id === "C" ? { ...node, label: "changed C" } : node
      )
    };
    const version2 = store.importTree(changed, tree.tree_id);
    assert.equal(version2.version, 2);
    const oldTree = store.getTreeVersion(tree.tree_id, 1);
    assert.match(oldTree?.payload ?? "", /D 的左子 C|"label":"C"/);
    assert.deepEqual(store.verifyRestoration(inorder.id).structureRestored, true);
    assert.equal(store.compareRuns(inorder.id, preorder.id).sameOrder, false);
    store.close();

    store = new MorrisStore(dbPath);
    const reloaded = store.getRun(inorder.id);
    assert.deepEqual(JSON.parse(reloaded?.order_json ?? "[]"), ["A", "B", "C", "D"]);
    const step = store.getStep(inorder.id, 1);
    assert.equal(step.step.current, "B");
    assert.equal(step.step.traversedEdge, null);
    assert.equal(JSON.parse(inorder.before_edges_json).length, 3);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
