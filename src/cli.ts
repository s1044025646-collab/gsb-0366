import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from './store';
import { validateTree } from './validate';
import { morrisTraverse, DEFAULT_MAX_STEPS } from './morris';
import { Step, TraversalOrder, TreeInput } from './types';

const dataDir = process.env.MORRIS_DATA_DIR ?? path.join(process.cwd(), 'data');
const dbPath = process.env.MORRIS_DB ?? path.join(dataDir, 'morris.db');

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readTreeFile(file: string): TreeInput {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TreeInput;
}

function printNodeTable(tree: TreeInput): void {
  console.log('节点表:');
  console.log('  id     | label                | left   | right');
  console.log('  -------+----------------------+--------+-------');
  for (const n of [...tree.nodes].sort((a, b) => a.id - b.id)) {
    const fmt = (v: number | null | undefined) => String(v ?? '-').padEnd(6);
    console.log(`  ${String(n.id).padEnd(6)} | ${JSON.stringify(n.label).padEnd(20)} | ${fmt(n.left)} | ${n.right ?? '-'}`);
  }
  console.log(`  rootId = ${tree.rootId ?? 'null'}`);
}

function printStep(step: Step): void {
  const head = `#${step.seq} [${step.type}] current=${step.current ?? '-'}` +
    (step.predecessor !== undefined ? ` predecessor=${step.predecessor}` : '') +
    (step.visited !== undefined ? ` VISIT=${step.visited}` : '');
  console.log(head);
  if (step.edge) {
    const e = step.edge;
    console.log(`    边变化: 节点 ${e.node}.${e.field}: ${e.oldValue ?? 'null'} -> ${e.newValue ?? 'null'} (${e.isOriginalEdge ? '原树边' : '临时线索'})`);
  }
  if (step.move) {
    console.log(`    移动: ${step.move.from} -> ${step.move.to ?? 'null'} (via ${step.move.via})`);
  }
  if (step.note) console.log(`    ${step.note}`);
}

const DEMO_TREE: TreeInput = {
  rootId: 2,
  nodes: [
    { id: 2, label: 'B', left: 1, right: 4 },
    { id: 1, label: 'A', left: null, right: null },
    { id: 4, label: 'D', left: 3, right: null },
    { id: 3, label: 'C', left: null, right: null },
  ],
};

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(dbPath);
  try {
    switch (cmd) {
      case 'import': {
        const file = args[0];
        if (!file) throw new Error('用法: cli import <tree.json> [--name 名称]');
        const tree = readTreeFile(file);
        const validation = validateTree(tree);
        if (!validation.ok) {
          console.error('校验失败:');
          for (const e of validation.errors) console.error(`  [${e.code}] ${e.message}`);
          process.exitCode = 1;
          return;
        }
        const record = store.importTree(tree, argValue(args, '--name') ?? 'default');
        console.log(`已导入 treeId=${record.id} name=${record.name} version=${record.version}`);
        break;
      }
      case 'validate': {
        const file = args[0];
        if (!file) throw new Error('用法: cli validate <tree.json>');
        const result = validateTree(readTreeFile(file));
        console.log(result.ok ? '结构合法' : '结构非法:');
        for (const e of result.errors) console.log(`  [${e.code}] ${e.message}`);
        process.exitCode = result.ok ? 0 : 1;
        break;
      }
      case 'run': {
        const treeId = Number(argValue(args, '--tree'));
        const order = argValue(args, '--order') as TraversalOrder;
        if (order !== 'inorder' && order !== 'preorder') throw new Error("用法: cli run --tree <id> --order inorder|preorder [--max-steps N]");
        const tree = store.getTree(treeId);
        if (!tree) throw new Error(`树 ${treeId} 不存在`);
        const maxStepsArg = argValue(args, '--max-steps');
        const maxSteps = maxStepsArg === undefined ? DEFAULT_MAX_STEPS : Number(maxStepsArg);
        const result = morrisTraverse(tree.payload, order, maxSteps);
        const run = store.saveRun(tree, result);
        console.log(`运行完成 runId=${run.id} order=${order} 算法版本=${run.algorithmVersion}`);
        console.log(`访问序列: ${result.sequence.join(' -> ') || '(空)'}`);
        console.log(`标签序列: ${result.labels.join(' -> ') || '(空)'}`);
        console.log(`总步骤数: ${result.totalSteps}，已记录 ${result.steps.length} 步${result.stepsTruncated ? '（解释已截短，遍历仍完整执行）' : ''}`);
        console.log(`结构恢复: ${result.structureRestored ? '通过（所有临时线索已移除）' : '失败'}`);
        break;
      }
      case 'sequence': {
        const run = store.getRun(Number(argValue(args, '--run')));
        if (!run) throw new Error('运行不存在');
        console.log(`runId=${run.id} order=${run.order} treeId=${run.treeId} v${run.treeVersion}`);
        console.log(`访问序列: ${run.sequence.join(' -> ') || '(空)'}`);
        console.log(`标签序列: ${run.labels.join(' -> ') || '(空)'}`);
        break;
      }
      case 'step': {
        const run = store.getRun(Number(argValue(args, '--run')));
        if (!run) throw new Error('运行不存在');
        const seq = Number(argValue(args, '--seq'));
        const step = (run.steps as Step[]).find((s) => s.seq === seq);
        if (!step) throw new Error(`步骤 ${seq} 不存在${run.stepsTruncated ? '（解释日志已截短）' : ''}`);
        printStep(step);
        break;
      }
      case 'steps': {
        const run = store.getRun(Number(argValue(args, '--run')));
        if (!run) throw new Error('运行不存在');
        for (const s of run.steps as Step[]) printStep(s);
        if (run.stepsTruncated) console.log(`... 解释已截短，总步骤数 ${run.totalSteps}`);
        break;
      }
      case 'verify': {
        const run = store.getRun(Number(argValue(args, '--run')));
        if (!run) throw new Error('运行不存在');
        const tree = store.getTree(run.treeId);
        if (!tree) throw new Error('关联的树不存在');
        const validation = validateTree(tree.payload);
        const eachOnce = new Set(run.sequence).size === run.sequence.length && run.sequence.length === tree.payload.nodes.length;
        console.log(`结构恢复标志: ${run.structureRestored ? '通过' : '失败'}`);
        console.log(`保存的树仍合法: ${validation.ok ? '是' : '否'}`);
        console.log(`每节点恰好访问一次: ${eachOnce ? '是' : '否'}（节点 ${tree.payload.nodes.length}，访问 ${run.sequence.length}）`);
        break;
      }
      case 'compare': {
        const treeId = Number(argValue(args, '--tree'));
        const tree = store.getTree(treeId);
        if (!tree) throw new Error(`树 ${treeId} 不存在`);
        const inorder = store.saveRun(tree, morrisTraverse(tree.payload, 'inorder'));
        const preorder = store.saveRun(tree, morrisTraverse(tree.payload, 'preorder'));
        console.log(`中序 (runId=${inorder.id}): ${inorder.sequence.join(' -> ') || '(空)'}`);
        console.log(`前序 (runId=${preorder.id}): ${preorder.sequence.join(' -> ') || '(空)'}`);
        const sameSet = JSON.stringify([...inorder.sequence].sort((a, b) => a - b)) === JSON.stringify([...preorder.sequence].sort((a, b) => a - b));
        console.log(`两种次序覆盖相同节点集合: ${sameSet ? '是' : '否'}`);
        break;
      }
      case 'export': {
        const run = store.getRun(Number(argValue(args, '--run')));
        if (!run) throw new Error('运行不存在');
        const tree = store.getTree(run.treeId);
        const report = { run, tree: tree?.payload };
        const out = argValue(args, '--out');
        const text = JSON.stringify(report, null, 2);
        if (out) {
          fs.writeFileSync(out, text, 'utf8');
          console.log(`报告已导出到 ${out}`);
        } else {
          console.log(text);
        }
        break;
      }
      case 'trees': {
        for (const t of store.listTrees()) console.log(`treeId=${t.id} name=${t.name} v${t.version} hash=${t.hash.slice(0, 12)}... ${t.createdAt}`);
        break;
      }
      case 'runs': {
        const treeIdArg = argValue(args, '--tree');
        for (const r of store.listRuns(treeIdArg === undefined ? undefined : Number(treeIdArg))) {
          console.log(`runId=${r.id} treeId=${r.treeId} v${r.treeVersion} order=${r.order} steps=${r.totalSteps}${r.stepsTruncated ? '(截短)' : ''} restored=${r.structureRestored} ${r.createdAt}`);
        }
        break;
      }
      case 'show': {
        const tree = store.getTree(Number(argValue(args, '--tree')));
        if (!tree) throw new Error('树不存在');
        printNodeTable(tree.payload);
        break;
      }
      case 'demo': {
        console.log('演示树: 根 B(2)，左子 A(1)，右子 D(4)，D 的左子 C(3)');
        printNodeTable(DEMO_TREE);
        const tree = store.importTree(DEMO_TREE, 'demo');
        const inorder = store.saveRun(tree, morrisTraverse(tree.payload, 'inorder'));
        const preorder = store.saveRun(tree, morrisTraverse(tree.payload, 'preorder'));
        console.log(`\n中序序列: ${inorder.labels.join(' -> ')}  (期望 A -> B -> C -> D)`);
        console.log(`前序序列: ${preorder.labels.join(' -> ')}  (期望 B -> A -> D -> C)`);
        console.log(`\n中序完整步骤 (runId=${inorder.id}):`);
        for (const s of inorder.steps as Step[]) printStep(s);
        console.log(`\n结构恢复: ${inorder.structureRestored && preorder.structureRestored ? '通过' : '失败'}`);
        break;
      }
      default:
        console.log(`Morris 遍历 CLI。数据库: ${dbPath}
命令:
  import <tree.json> [--name N]   导入树（校验后保存为不可变版本）
  validate <tree.json>            仅校验结构
  run --tree ID --order inorder|preorder [--max-steps N]
  sequence --run ID               查看访问序列
  steps --run ID                  查看全部已记录步骤
  step --run ID --seq N           查看某一步的指针变化
  verify --run ID                 核验结构恢复
  compare --tree ID               对比中序与前序
  export --run ID [--out file]    导出报告 JSON
  show --tree ID                  节点表
  trees / runs [--tree ID]        列表
  demo                            内置演示`);
    }
  } finally {
    store.close();
  }
}

main();
