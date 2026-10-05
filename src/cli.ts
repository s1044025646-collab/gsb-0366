import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MorrisStore } from "./db.js";
import { MorrisResult, MorrisStep, StoredRun, TraversalMode, TreeInput } from "./types.js";

interface CliContext {
  command: string;
  args: string[];
  options: Map<string, string>;
}

const DEFAULT_DB = "data/morris.sqlite";

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const store = new MorrisStore(resolve(parsed.options.get("--db") ?? DEFAULT_DB));

  try {
    switch (parsed.command) {
      case "import":
        print(store.importTree(readPayload(parsed)));
        break;
      case "new-version": {
        const treeId = requiredNumber(parsed, 0, "treeId");
        print(store.importTree(readPayload(parsed), treeId));
        break;
      }
      case "validate":
        print(store.validateTree(requiredNumber(parsed, 0, "treeId"), optionalNumber(parsed, "--version")));
        break;
      case "run": {
        const treeId = requiredNumber(parsed, 0, "treeId");
        const mode = parseMode(requiredText(parsed, 1, "mode(inorder|preorder)"));
        const saved = store.runAndSave(treeId, mode, optionalNumber(parsed, "--version"));
        print(runView(store, saved.run, saved.result, optionalNumber(parsed, "--max-steps")));
        break;
      }
      case "order": {
        const run = store.getRun(requiredNumber(parsed, 0, "runId"));
        const result = store.resultFromRun(run);
        print({ runId: run.id, mode: run.mode, order: labeledOrder(store, run, result.order) });
        break;
      }
      case "step":
        print(store.getStep(requiredNumber(parsed, 0, "runId"), requiredNumber(parsed, 1, "stepIndex")));
        break;
      case "verify":
        print(store.verifyRestoration(requiredNumber(parsed, 0, "runId")));
        break;
      case "compare":
        print(store.compareRuns(requiredNumber(parsed, 0, "firstRunId"), requiredNumber(parsed, 1, "secondRunId")));
        break;
      case "report": {
        const report = store.exportReport(requiredNumber(parsed, 0, "runId"), optionalNumber(parsed, "--max-steps"));
        const output = parsed.options.get("--out");
        if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2), "utf8");
        print(output ? { exportedTo: resolve(output), runId: report.run.id, totalSteps: report.totalSteps } : report);
        break;
      }
      case "list":
        print({ trees: store.listTrees(), runs: store.listRuns() });
        break;
      case "demo":
        print(runDemo(store));
        break;
      default:
        printUsageAndExit();
    }
  } finally {
    store.close();
  }
}

function runDemo(store: MorrisStore) {
  const tree: TreeInput = {
    rootId: "B",
    nodes: [
      { id: "B", label: "B", left: "A", right: "D" },
      { id: "A", label: "A", left: null, right: null },
      { id: "D", label: "D", left: "C", right: null },
      { id: "C", label: "C", left: null, right: null }
    ]
  };
  const savedTree = store.importTree(tree);
  const inorder = store.runAndSave(savedTree.tree_id, "inorder", savedTree.version);
  const preorder = store.runAndSave(savedTree.tree_id, "preorder", savedTree.version);
  return {
    tree: { treeId: savedTree.tree_id, version: savedTree.version },
    expected: { inorder: ["A", "B", "C", "D"], preorder: ["B", "A", "D", "C"] },
    inorder: runView(store, inorder.run, inorder.result),
    preorder: runView(store, preorder.run, preorder.result),
    comparison: store.compareRuns(inorder.run.id, preorder.run.id),
    inorderVerification: store.verifyRestoration(inorder.run.id),
    temporaryThreadSteps: inorder.result.steps
      .filter((step) => step.kind === "thread-create" || step.kind === "thread-remove")
      .map((step) => ({ index: step.index, kind: step.kind, note: step.note, pointer: step.pointer }))
  };
}

function runView(
  store: MorrisStore,
  run: StoredRun,
  result: MorrisResult,
  maxSteps?: number
) {
  const steps = maxSteps === undefined ? result.steps : result.steps.slice(0, maxSteps);
  return {
    runId: run.id,
    treeId: run.tree_id,
    treeVersion: run.tree_version,
    mode: run.mode,
    algorithmVersion: run.algorithm_version,
    order: labeledOrder(store, run, result.order),
    stepCount: result.steps.length,
    shownSteps: steps.length,
    steps: steps.map(formatStep),
    temporaryThreadsCreated: result.temporaryThreadsCreated,
    temporaryThreadsRemoved: result.temporaryThreadsRemoved,
    structureRestored: result.structureRestored
  };
}

function formatStep(step: MorrisStep) {
  return {
    index: step.index,
    kind: step.kind,
    current: step.current,
    predecessor: step.predecessor,
    pointer: step.pointer,
    activeThreads: step.activeThreads,
    note: step.note
  };
}

function labeledOrder(store: MorrisStore, run: StoredRun, order: string[]) {
  const tree = store.getTreeVersion(run.tree_id, run.tree_version);
  const input = JSON.parse(tree?.payload ?? "{}") as TreeInput;
  const labels = new Map(input.nodes.map((node) => [node.id, node.label]));
  return order.map((id) => ({ id, label: labels.get(id) ?? null }));
}

function readPayload(context: CliContext): TreeInput {
  const file = context.options.get("--file");
  const inline = context.options.get("--json");
  if (file && inline) throw new Error("--file 与 --json 不能同时使用");
  const text = file ? readFileSync(resolve(file), "utf8") : inline;
  if (text === undefined) throw new Error("请通过 --file tree.json 或 --json '{...}' 提供树");
  return JSON.parse(text) as TreeInput;
}

function parseArgs(argv: string[]): CliContext {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        options.set(token, "true");
      } else {
        options.set(token, next);
        index += 1;
      }
    } else {
      positional.push(token);
    }
  }
  const [command = "help", ...args] = positional;
  return { command, args, options };
}

function requiredNumber(context: CliContext, index: number, name: string): number {
  const value = context.args[index];
  if (!/^-?\d+$/.test(value ?? "")) throw new Error(`${name} 必须是整数`);
  return Number(value);
}

function optionalNumber(context: CliContext, name: string): number | undefined {
  const value = context.options.get(name);
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value)) throw new Error(`${name} 必须是整数`);
  return Number(value);
}

function requiredText(context: CliContext, index: number, name: string): string {
  const value = context.args[index];
  if (value === undefined) throw new Error(`缺少参数：${name}`);
  return value;
}

function parseMode(value: string): TraversalMode {
  if (value === "inorder" || value === "preorder") return value;
  throw new Error("mode 必须是 inorder 或 preorder");
}

function print(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printUsageAndExit(): never {
  console.log(`Morris 二叉树遍历教学 CLI

用法:
  npm run cli -- import --file examples/demo.json
  npm run cli -- new-version 1 --file new.json
  npm run cli -- validate 1 [--version 1]
  npm run cli -- run 1 inorder|preorder [--max-steps 10]
  npm run cli -- order RUN_ID
  npm run cli -- step RUN_ID STEP_INDEX
  npm run cli -- verify RUN_ID
  npm run cli -- compare FIRST_RUN_ID SECOND_RUN_ID
  npm run cli -- report RUN_ID [--max-steps 10] [--out report.json]
  npm run cli -- list
  npm run cli -- demo

公共选项: --db data/morris.sqlite
`);
  process.exit(1);
}

main();
