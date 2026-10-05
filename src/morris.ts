import { MorrisServiceError, StructuralEdge } from "./types.js";
import {
  ALGORITHM_VERSION,
  MorrisResult,
  MorrisStep,
  TraversalMode,
  TruncationOptions
} from "./types.js";
import { ValidatedTree } from "./validation.js";

interface WorkNode {
  id: string;
  label: string;
  left: string | null;
  right: string | null;
}

export function runMorris(
  tree: ValidatedTree,
  mode: TraversalMode
): MorrisResult {
  if (mode !== "inorder" && mode !== "preorder") {
    throw new MorrisServiceError(
      "INVALID_ARGUMENT",
      "遍历方式必须是 inorder 或 preorder",
      { mode }
    );
  }

  const beforeEdges = collectEdges(tree.nodes);
  const work = new Map<string, WorkNode>();
  for (const [id, node] of tree.nodes) {
    work.set(id, { ...node });
  }

  const order: string[] = [];
  const steps: MorrisStep[] = [];
  const activeThreads = new Set<string>();
  let created = 0;
  let removed = 0;
  let current = tree.rootId;

  const originalEdgeKeys = new Set(
    beforeEdges.map((edge) => `${edge.from}:${edge.side}:${edge.to}`)
  );

  function activeThreadList(): StructuralEdge[] {
    const edges: StructuralEdge[] = [];
    for (const from of activeThreads) {
      const node = work.get(from) as WorkNode;
      if (node.right !== null) {
        edges.push({ from, side: "right", to: node.right, temporary: true });
      }
    }
    return edges;
  }

  function addStep(
    kind: MorrisStep["kind"],
    predecessor: string | null,
    note: string,
    pointer?: MorrisStep["pointer"],
    traversedEdge?: StructuralEdge
  ): void {
    const threads = activeThreadList();
    steps.push({
      index: steps.length + 1,
      kind,
      current,
      predecessor,
      pointer,
      traversedEdge: traversedEdge ?? null,
      activeThreads: threads,
      note
    });
  }

  function visit(id: string): void {
    order.push(id);
    addStep("visit", null, `访问节点 ${id}（${work.get(id)?.label ?? ""}）`);
  }

  while (current !== null) {
    const currentNode = work.get(current);
    if (!currentNode) {
      throw new MorrisServiceError(
        "INTERNAL_INVARIANT_FAILED",
        `工作副本缺少当前节点：${current}`
      );
    }

    if (currentNode.left === null) {
      visit(current);
      const next = currentNode.right;
      const edge: StructuralEdge | null =
        next === null
          ? null
          : {
              from: current,
              side: "right",
              to: next,
              temporary: activeThreads.has(current)
            };
      addStep(
        "move-right",
        null,
        next === null ? "右行为空，当前分支结束" : `沿${describeEdge(current, "right", next, originalEdgeKeys)}移动`,
        undefined,
        edge ?? undefined
      );
      current = next;
      continue;
    }

    let predecessor = currentNode.left;
    addStep(
      "find-predecessor-start",
      predecessor,
      `从左子节点 ${predecessor} 开始寻找中序前驱`
    );

    let predecessorNode = work.get(predecessor);
    if (!predecessorNode) {
      throw new MorrisServiceError(
        "INTERNAL_INVARIANT_FAILED",
        `工作副本缺少前驱节点：${predecessor}`
      );
    }

    while (predecessorNode.right !== null && predecessorNode.right !== current) {
      const nextPredecessor = predecessorNode.right;
      const temporary = activeThreads.has(predecessor);
      addStep(
        "find-predecessor-move",
        nextPredecessor,
        `前驱搜索沿${temporary ? "临时线索" : describeEdge(predecessor, "right", nextPredecessor, originalEdgeKeys)}移动到 ${nextPredecessor}`
        ,
        undefined,
        {
          from: predecessor,
          side: "right",
          to: nextPredecessor,
          temporary
        }
      );
      predecessor = nextPredecessor;
      predecessorNode = work.get(predecessor);
      if (!predecessorNode) {
        throw new MorrisServiceError(
          "INTERNAL_INVARIANT_FAILED",
          `工作副本缺少前驱节点：${predecessor}`
        );
      }
    }

    if (predecessorNode.right === null) {
      predecessorNode.right = current;
      activeThreads.add(predecessor);
      created += 1;
      addStep(
        "thread-create",
        predecessor,
        `建立临时返回线索：${predecessor}.right 从 null 改为 ${current}；该边不是原树边`,
        { side: "right", oldValue: null, newValue: current }
      );

      if (mode === "preorder") {
        visit(current);
      }

      const next = currentNode.left;
      addStep(
        "move-left",
        predecessor,
        `沿原树边 ${current}.left -> ${next} 向左继续`,
        undefined,
        { from: current, side: "left", to: next, temporary: false }
      );
      current = next;
    } else {
      if (predecessorNode.right !== current || !activeThreads.has(predecessor)) {
        throw new MorrisServiceError(
          "INTERNAL_INVARIANT_FAILED",
          "前驱右指针指回当前节点，但未登记为本次临时线索",
          { current, predecessor, target: predecessorNode.right }
        );
      }

      predecessorNode.right = null;
      activeThreads.delete(predecessor);
      removed += 1;
      addStep(
        "thread-remove",
        predecessor,
        `拆除临时返回线索：${predecessor}.right 从 ${current} 恢复为 null`,
        { side: "right", oldValue: current, newValue: null }
      );

      if (mode === "inorder") {
        visit(current);
      }

      const next = currentNode.right;
      const edge: StructuralEdge | null =
        next === null
          ? null
          : {
              from: current,
              side: "right",
              to: next,
              temporary: false
            };
      addStep(
        "move-right",
        predecessor,
        next === null
          ? "左子树已完成，右行为空，当前分支结束"
          : `左子树已完成，沿${describeEdge(current, "right", next, originalEdgeKeys)}移动`,
        undefined,
        edge ?? undefined
      );
      current = next;
    }
  }

  addStep("finish", null, "当前节点为空，Morris 遍历正常结束");

  const afterEdges = collectEdges(work);
  const structureRestored = edgesEqual(beforeEdges, afterEdges);
  if (created !== removed || activeThreads.size !== 0 || !structureRestored) {
    throw new MorrisServiceError(
      "INTERNAL_INVARIANT_FAILED",
      "遍历结束后工作副本未能恢复为输入结构",
      {
        created,
        removed,
        activeThreads: [...activeThreads],
        beforeEdges,
        afterEdges
      }
    );
  }

  if (order.length !== tree.nodes.size || new Set(order).size !== order.length) {
    throw new MorrisServiceError(
      "INTERNAL_INVARIANT_FAILED",
      "访问序列未满足每个节点恰好访问一次",
      { order, nodeCount: tree.nodes.size }
    );
  }

  return {
    mode,
    order,
    steps,
    temporaryThreadsCreated: created,
    temporaryThreadsRemoved: removed,
    structureRestored,
    beforeEdges,
    afterEdges,
    algorithmVersion: ALGORITHM_VERSION
  };
}

export function truncateResult(
  result: MorrisResult,
  options: TruncationOptions = {}
): { steps: MorrisStep[]; truncated: boolean; totalSteps: number } {
  const maxSteps = options.maxSteps;
  if (
    maxSteps === undefined ||
    !Number.isInteger(maxSteps) ||
    maxSteps < 0 ||
    maxSteps >= result.steps.length
  ) {
    return {
      steps: result.steps,
      truncated: false,
      totalSteps: result.steps.length
    };
  }
  return {
    steps: result.steps.slice(0, maxSteps),
    truncated: true,
    totalSteps: result.steps.length
  };
}

function collectEdges(
  nodes: Map<string, { id: string; left: string | null; right: string | null }>
): StructuralEdge[] {
  const edges: StructuralEdge[] = [];
  for (const node of nodes.values()) {
    if (node.left !== null) {
      edges.push({ from: node.id, side: "left", to: node.left, temporary: false });
    }
    if (node.right !== null) {
      edges.push({ from: node.id, side: "right", to: node.right, temporary: false });
    }
  }
  return edges.sort(edgeCompare);
}

function edgesEqual(a: StructuralEdge[], b: StructuralEdge[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort(edgeCompare);
  const right = [...b].sort(edgeCompare);
  return left.every((edge, index) => {
    const other = right[index];
    return (
      edge.from === other.from &&
      edge.side === other.side &&
      edge.to === other.to &&
      edge.temporary === other.temporary
    );
  });
}

function edgeCompare(a: StructuralEdge, b: StructuralEdge): number {
  return `${a.from}:${a.side}:${a.to}`.localeCompare(
    `${b.from}:${b.side}:${b.to}`
  );
}

function describeEdge(
  from: string,
  side: "left" | "right",
  to: string,
  originalKeys: Set<string>
): string {
  const temporary = !originalKeys.has(`${from}:${side}:${to}`);
  return `${temporary ? "临时线索" : "原树边"} ${from}.${side} -> ${to}`;
}
