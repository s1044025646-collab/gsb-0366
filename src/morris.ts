import { Step, TraversalOrder, TraversalResult, TreeInput } from './types';

export const ALGORITHM_VERSION = 'morris-1.0.0';
export const DEFAULT_MAX_STEPS = 2000;

interface WorkNode {
  id: number;
  label: string;
  left: WorkNode | null;
  right: WorkNode | null;
}

function buildWorkCopy(input: TreeInput): { root: WorkNode | null; byId: Map<number, WorkNode> } {
  const byId = new Map<number, WorkNode>();
  for (const n of input.nodes) {
    byId.set(n.id, { id: n.id, label: n.label, left: null, right: null });
  }
  for (const n of input.nodes) {
    const w = byId.get(n.id)!;
    w.left = n.left === null || n.left === undefined ? null : byId.get(n.left)!;
    w.right = n.right === null || n.right === undefined ? null : byId.get(n.right)!;
  }
  const root = input.rootId === null || input.rootId === undefined ? null : byId.get(input.rootId)!;
  return { root, byId };
}

/** 逐引用比较工作副本与输入是否结构一致（含标签） */
export function structureMatches(input: TreeInput, byId: Map<number, WorkNode>): boolean {
  if (input.nodes.length !== byId.size) return false;
  for (const n of input.nodes) {
    const w = byId.get(n.id);
    if (!w) return false;
    if (w.label !== n.label) return false;
    const left = n.left ?? null;
    const right = n.right ?? null;
    if ((w.left ? w.left.id : null) !== left) return false;
    if ((w.right ? w.right.id : null) !== right) return false;
  }
  return true;
}

/**
 * Morris 遍历核心：不使用递归、不使用显式栈保存祖先。
 * 临时线索只作用于本次计算的工作副本。
 * maxSteps 仅截断解释日志，遍历始终执行到完成并拆除全部线索。
 */
export function morrisTraverse(
  input: TreeInput,
  order: TraversalOrder,
  maxSteps: number = DEFAULT_MAX_STEPS,
): TraversalResult {
  const { root, byId } = buildWorkCopy(input);
  const sequence: number[] = [];
  const labels: string[] = [];
  const steps: Step[] = [];
  let totalSteps = 0;

  const log = (step: Omit<Step, 'seq'>): void => {
    totalSteps += 1;
    if (steps.length < maxSteps) {
      steps.push({ seq: totalSteps, ...step });
    }
  };

  const visit = (node: WorkNode): void => {
    sequence.push(node.id);
    labels.push(node.label);
    log({ type: 'visit', current: node.id, visited: node.id, note: `访问节点 ${node.id}（标签 ${JSON.stringify(node.label)}）` });
  };

  let current = root;
  while (current !== null) {
    if (current.left === null) {
      visit(current);
      const next = current.right;
      log({
        type: 'move',
        current: current.id,
        move: { from: current.id, to: next ? next.id : null, via: 'right' },
        note: `节点 ${current.id} 无左子树，沿右指针移动`,
      });
      current = next;
    } else {
      // 在左子树中寻找中序前驱
      let predecessor = current.left;
      log({
        type: 'find-predecessor',
        current: current.id,
        predecessor: predecessor.id,
        note: `在节点 ${current.id} 的左子树中寻找中序前驱，从 ${predecessor.id} 开始`,
      });
      while (predecessor.right !== null && predecessor.right !== current) {
        predecessor = predecessor.right;
        log({
          type: 'find-predecessor',
          current: current.id,
          predecessor: predecessor.id,
          note: `沿右指针继续到 ${predecessor.id}`,
        });
      }
      if (predecessor.right === null) {
        // 建立临时线索
        if (order === 'preorder') visit(current);
        log({
          type: 'link',
          current: current.id,
          predecessor: predecessor.id,
          edge: { node: predecessor.id, field: 'right', oldValue: null, newValue: current.id, isOriginalEdge: false },
          note: `前驱 ${predecessor.id} 的右指针为空，临时指向 ${current.id}（临时线索，非原树边）`,
        });
        predecessor.right = current;
        const next = current.left;
        log({
          type: 'move',
          current: current.id,
          move: { from: current.id, to: next.id, via: 'left' },
          note: `转向节点 ${current.id} 的左子树`,
        });
        current = next;
      } else {
        // predecessor.right === current：线索已存在，拆除
        log({
          type: 'unlink',
          current: current.id,
          predecessor: predecessor.id,
          edge: { node: predecessor.id, field: 'right', oldValue: current.id, newValue: null, isOriginalEdge: false },
          note: `前驱 ${predecessor.id} 的右指针已是指回 ${current.id} 的临时线索，拆除并恢复为 null`,
        });
        predecessor.right = null;
        if (order === 'inorder') visit(current);
        const next = current.right;
        log({
          type: 'move',
          current: current.id,
          move: { from: current.id, to: next ? next.id : null, via: 'right' },
          note: `节点 ${current.id} 的左子树已完成，沿右指针移动`,
        });
        current = next;
      }
    }
  }

  const structureRestored = structureMatches(input, byId);
  if (!structureRestored) {
    throw new Error('INTERNAL_RESTORE_FAILURE: 遍历结束后工作副本与输入结构不一致');
  }
  return {
    order,
    sequence,
    labels,
    steps,
    totalSteps,
    stepsTruncated: steps.length < totalSteps,
    structureRestored,
  };
}
