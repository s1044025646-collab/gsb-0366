import {
  DEFAULT_LIMITS,
  Limits,
  MorrisServiceError,
  TreeInput
} from "./types.js";

interface NormalizedNode {
  id: string;
  label: string;
  left: string | null;
  right: string | null;
}

export interface ValidatedTree {
  rootId: string | null;
  nodes: Map<string, NormalizedNode>;
}

export function validateTree(
  input: unknown,
  limits: Limits = DEFAULT_LIMITS
): ValidatedTree {
  if (typeof input !== "object" || input === null) {
    throw new MorrisServiceError("EMPTY_INPUT", "请求体必须是对象");
  }

  const candidate = input as Partial<TreeInput>;
  if (!Array.isArray(candidate.nodes)) {
    throw new MorrisServiceError("INVALID_ARGUMENT", "nodes 必须是数组");
  }

  const nodes = candidate.nodes;
  if (nodes.length > limits.maxNodes) {
    throw new MorrisServiceError(
      "MAX_NODES_EXCEEDED",
      `节点数 ${nodes.length} 超过上限 ${limits.maxNodes}`,
      { actual: nodes.length, limit: limits.maxNodes }
    );
  }

  if (
    candidate.rootId !== null &&
    candidate.rootId !== undefined &&
    typeof candidate.rootId !== "string"
  ) {
    throw new MorrisServiceError("INVALID_ARGUMENT", "rootId 必须是字符串或 null");
  }

  if (candidate.rootId === undefined && nodes.length > 0) {
    throw new MorrisServiceError("INVALID_ARGUMENT", "非空树必须提供 rootId");
  }

  const rootId = candidate.rootId === undefined ? null : candidate.rootId;
  if (nodes.length === 0 && rootId !== null) {
    throw new MorrisServiceError(
      "ROOT_NOT_FOUND",
      "空树的 rootId 必须为 null",
      { rootId }
    );
  }

  const normalized = new Map<string, NormalizedNode>();

  for (const rawNode of nodes) {
    if (typeof rawNode !== "object" || rawNode === null) {
      throw new MorrisServiceError("INVALID_ARGUMENT", "每个节点必须是对象");
    }
    const node = rawNode as {
      id?: unknown;
      label?: unknown;
      left?: unknown;
      right?: unknown;
    };

    if (typeof node.id !== "string" || node.id.length === 0) {
      throw new MorrisServiceError("INVALID_NODE_ID", "节点 id 必须是非空字符串");
    }
    if (normalized.has(node.id)) {
      throw new MorrisServiceError("DUPLICATE_NODE_ID", `节点编号重复：${node.id}`, {
        id: node.id
      });
    }
    if (typeof node.label !== "string") {
      throw new MorrisServiceError(
        "INVALID_ARGUMENT",
        `节点 ${node.id} 的 label 必须是字符串`
      );
    }
    if (node.label.length > limits.maxLabelLength) {
      throw new MorrisServiceError(
        "LABEL_TOO_LONG",
        `节点 ${node.id} 标签长度超过上限 ${limits.maxLabelLength}`,
        { id: node.id, actual: node.label.length, limit: limits.maxLabelLength }
      );
    }

    const left = normalizeChild(node.left, node.id, "left");
    const right = normalizeChild(node.right, node.id, "right");
    if (node.id === left || node.id === right) {
      throw new MorrisServiceError("SELF_REFERENCE", `节点不能自环：${node.id}`, {
        id: node.id
      });
    }

    normalized.set(node.id, { id: node.id, label: node.label, left, right });
  }

  if (rootId !== null && !normalized.has(rootId)) {
    throw new MorrisServiceError("ROOT_NOT_FOUND", `根节点不存在：${rootId}`, {
      rootId
    });
  }

  for (const node of normalized.values()) {
    for (const child of [node.left, node.right]) {
      if (child !== null && !normalized.has(child)) {
        throw new MorrisServiceError(
          "UNKNOWN_REFERENCE",
          `节点 ${node.id} 引用了未知节点：${child}`,
          { from: node.id, to: child }
        );
      }
    }
  }

  const parent = new Map<string, string>();
  for (const node of normalized.values()) {
    for (const side of ["left", "right"] as const) {
      const child = node[side];
      if (child === null) continue;
      const existingParent = parent.get(child);
      if (existingParent !== undefined) {
        throw new MorrisServiceError(
          "DUPLICATE_PARENT",
          `节点 ${child} 同时有两个父边：${existingParent} 和 ${node.id}`,
          { child, parents: [existingParent, node.id] }
        );
      }
      parent.set(child, node.id);
    }
  }

  const roots = [...normalized.keys()].filter((id) => !parent.has(id));
  if (nodes.length > 0) {
    if (roots.length > 1) {
      throw new MorrisServiceError(
        "MULTIPLE_ROOTS",
        `检测到多个无根节点：${roots.join(", ")}`,
        { roots }
      );
    }
  }

  const reachable = new Set<string>();
  if (rootId !== null) {
    const stack: string[] = [rootId];
    const active = new Set<string>([rootId]);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (reachable.has(id)) {
        throw new MorrisServiceError("CYCLE_DETECTED", `检测到环：${id}`, {
          nodeId: id
        });
      }
      reachable.add(id);
      active.delete(id);
      const node = normalized.get(id) as NormalizedNode;
      for (const child of [node.left, node.right]) {
        if (child !== null) {
          if (active.has(child)) {
            throw new MorrisServiceError("CYCLE_DETECTED", `检测到环：${child}`, {
              nodeId: child
            });
          }
          stack.push(child);
          active.add(child);
        }
      }
    }
  }

  const unreachable = [...normalized.keys()].filter((id) => !reachable.has(id));
  if (unreachable.length > 0) {
    throw new MorrisServiceError(
      "UNREACHABLE_NODE",
      `存在从根不可达节点：${unreachable.join(", ")}`,
      { unreachable }
    );
  }

  if (nodes.length > 0 && roots.length === 1 && roots[0] !== rootId) {
    throw new MorrisServiceError(
      "ROOT_NOT_FOUND",
      `声明根 ${rootId} 与结构根 ${roots[0]} 不一致`,
      { declaredRoot: rootId, structuralRoot: roots[0] }
    );
  }

  return { rootId, nodes: normalized };
}

function normalizeChild(
  value: unknown,
  nodeId: string,
  side: "left" | "right"
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new MorrisServiceError(
      "INVALID_ARGUMENT",
      `节点 ${nodeId} 的 ${side} 引用必须是字符串或 null`
    );
  }
  return value;
}
