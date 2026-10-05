import { NodeInput, TreeInput, ValidationError, ValidationResult } from './types';

export const MAX_NODES = 10000;
export const MAX_LABEL_LENGTH = 1024;

/**
 * 结构校验：拒绝一般有向图冒充树。
 * 允许使用集合/栈（此阶段不属于正式 Morris 核心）。
 */
export function validateTree(input: TreeInput): ValidationResult {
  const errors: ValidationError[] = [];
  if (!input || typeof input !== 'object' || !Array.isArray(input.nodes)) {
    return { ok: false, errors: [{ code: 'BAD_SHAPE', message: '输入必须是 { rootId, nodes[] }' }] };
  }
  const nodes = input.nodes;
  if (nodes.length > MAX_NODES) {
    errors.push({ code: 'LIMIT_EXCEEDED', message: `节点数 ${nodes.length} 超过上限 ${MAX_NODES}` });
    return { ok: false, errors };
  }

  const byId = new Map<number, NodeInput>();
  for (const n of nodes) {
    if (typeof n.id !== 'number' || !Number.isInteger(n.id)) {
      errors.push({ code: 'BAD_ID', message: '节点编号必须是整数', nodeId: n.id });
      continue;
    }
    if (byId.has(n.id)) {
      errors.push({ code: 'DUPLICATE_ID', message: `节点编号 ${n.id} 重复`, nodeId: n.id });
      continue;
    }
    if (typeof n.label !== 'string') {
      errors.push({ code: 'BAD_LABEL', message: '标签必须是字符串', nodeId: n.id });
      continue;
    }
    if (n.label.length > MAX_LABEL_LENGTH) {
      errors.push({ code: 'LIMIT_EXCEEDED', message: `标签长度超过上限 ${MAX_LABEL_LENGTH}`, nodeId: n.id });
      continue;
    }
    byId.set(n.id, n);
  }
  if (errors.length) return { ok: false, errors };

  if (byId.size === 0) {
    if (input.rootId !== null && input.rootId !== undefined) {
      errors.push({ code: 'ROOT_NOT_FOUND', message: '空树的 rootId 必须为 null' });
    }
    return { ok: errors.length === 0, errors };
  }

  const parentCount = new Map<number, number>();
  for (const n of byId.values()) {
    for (const [field, ref] of [['left', n.left], ['right', n.right]] as const) {
      if (ref === null || ref === undefined) continue;
      if (!byId.has(ref)) {
        errors.push({ code: 'UNKNOWN_REF', message: `节点 ${n.id} 的 ${field} 引用了不存在的节点 ${ref}`, nodeId: n.id });
        continue;
      }
      if (ref === n.id) {
        errors.push({ code: 'SELF_LOOP', message: `节点 ${n.id} 的 ${field} 指向自身`, nodeId: n.id });
      }
      parentCount.set(ref, (parentCount.get(ref) ?? 0) + 1);
    }
  }
  for (const [id, count] of parentCount) {
    if (count > 1) {
      errors.push({ code: 'MULTIPLE_PARENTS', message: `节点 ${id} 有 ${count} 个父节点（共享子节点不是树）`, nodeId: id });
    }
  }
  if (errors.length) return { ok: false, errors };

  if (input.rootId === null || input.rootId === undefined) {
    errors.push({ code: 'ROOT_NOT_FOUND', message: '非空树必须提供 rootId' });
    return { ok: false, errors };
  }
  const rootId = input.rootId;
  if (!byId.has(rootId)) {
    errors.push({ code: 'ROOT_NOT_FOUND', message: `rootId ${rootId} 不存在于节点表中` });
    return { ok: false, errors };
  }
  if ((parentCount.get(rootId) ?? 0) !== 0) {
    errors.push({ code: 'ROOT_HAS_PARENT', message: `根节点 ${rootId} 被其他节点引用`, nodeId: rootId });
  }

  // 根唯一：除根外每个节点必须恰好有一个父节点
  for (const id of byId.keys()) {
    if (id !== rootId && (parentCount.get(id) ?? 0) === 0) {
      errors.push({ code: 'MULTIPLE_ROOTS', message: `节点 ${id} 没有父节点，存在多个根 / 森林`, nodeId: id });
    }
  }
  if (errors.length) return { ok: false, errors };

  // 从根 DFS：检查不可达节点与环
  const visited = new Set<number>();
  const inStack = new Set<number>();
  const stack: number[] = [rootId];
  inStack.add(rootId);
  while (stack.length) {
    const id = stack.pop()!;
    visited.add(id);
    const n = byId.get(id)!;
    for (const ref of [n.left, n.right]) {
      if (ref === null || ref === undefined) continue;
      if (inStack.has(ref)) {
        errors.push({ code: 'CYCLE', message: `检测到环：节点 ${ref} 在遍历路径上被再次到达`, nodeId: ref });
        continue;
      }
      if (!visited.has(ref)) {
        inStack.add(ref);
        stack.push(ref);
      }
    }
    inStack.delete(id);
  }
  for (const id of byId.keys()) {
    if (!visited.has(id)) {
      errors.push({ code: 'UNREACHABLE', message: `节点 ${id} 从根不可达`, nodeId: id });
    }
  }
  return { ok: errors.length === 0, errors };
}
