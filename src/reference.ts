import { TreeInput } from "./types.js";

export function recursiveInorder(input: TreeInput): string[] {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const output: string[] = [];
  function visit(id: string | null): void {
    if (id === null) return;
    const node = byId.get(id);
    if (!node) throw new Error(`测试基准遇到未知节点：${id}`);
    visit(node.left ?? null);
    output.push(id);
    visit(node.right ?? null);
  }
  visit(input.rootId);
  return output;
}

export function recursivePreorder(input: TreeInput): string[] {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const output: string[] = [];
  function visit(id: string | null): void {
    if (id === null) return;
    const node = byId.get(id);
    if (!node) throw new Error(`测试基准遇到未知节点：${id}`);
    output.push(id);
    visit(node.left ?? null);
    visit(node.right ?? null);
  }
  visit(input.rootId);
  return output;
}

export function edgeReferences(input: TreeInput) {
  return input.nodes
    .flatMap((node) => [
      node.left ? { from: node.id, side: "left" as const, to: node.left, temporary: false } : null,
      node.right ? { from: node.id, side: "right" as const, to: node.right, temporary: false } : null
    ])
    .filter((edge): edge is NonNullable<typeof edge> => edge !== null)
    .sort((a, b) => `${a.from}:${a.side}:${a.to}`.localeCompare(`${b.from}:${b.side}:${b.to}`));
}
