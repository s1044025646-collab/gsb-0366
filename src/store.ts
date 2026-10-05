import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TraversalOrder, TraversalResult, TreeInput } from './types';
import { ALGORITHM_VERSION } from './morris';

export interface TreeRecord {
  id: number;
  name: string;
  version: number;
  hash: string;
  payload: TreeInput;
  createdAt: string;
}

export interface RunRecord {
  id: number;
  treeId: number;
  treeVersion: number;
  order: TraversalOrder;
  algorithmVersion: string;
  sequence: number[];
  labels: string[];
  steps: unknown[];
  totalSteps: number;
  stepsTruncated: boolean;
  structureRestored: boolean;
  createdAt: string;
}

function hashTree(input: TreeInput): string {
  const canonical = JSON.stringify({
    rootId: input.rootId ?? null,
    nodes: [...input.nodes]
      .map((n) => ({ id: n.id, label: n.label, left: n.left ?? null, right: n.right ?? null }))
      .sort((a, b) => a.id - b.id),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        hash TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id INTEGER NOT NULL REFERENCES trees(id),
        tree_version INTEGER NOT NULL,
        traversal_order TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        sequence TEXT NOT NULL,
        labels TEXT NOT NULL,
        steps TEXT NOT NULL,
        total_steps INTEGER NOT NULL,
        steps_truncated INTEGER NOT NULL,
        structure_restored INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 导入不可变树版本：同名不同内容产生新版本，同内容复用旧记录 */
  importTree(input: TreeInput, name = 'default'): TreeRecord {
    const hash = hashTree(input);
    const existing = this.db.prepare('SELECT * FROM trees WHERE hash = ?').get(hash) as Record<string, unknown> | undefined;
    if (existing) return this.rowToTree(existing);
    const versionRow = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM trees WHERE name = ?').get(name) as { v: number };
    const version = versionRow.v + 1;
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare('INSERT INTO trees (name, version, hash, payload, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, version, hash, JSON.stringify(input), createdAt);
    return { id: Number(result.lastInsertRowid), name, version, hash, payload: input, createdAt };
  }

  getTree(id: number): TreeRecord | null {
    const row = this.db.prepare('SELECT * FROM trees WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToTree(row) : null;
  }

  listTrees(): TreeRecord[] {
    const rows = this.db.prepare('SELECT * FROM trees ORDER BY id').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToTree(r));
  }

  /** 原子保存一次完整运行的结果 */
  saveRun(tree: TreeRecord, result: TraversalResult): RunRecord {
    const createdAt = new Date().toISOString();
    const result2 = this.db
      .prepare(
        `INSERT INTO runs (tree_id, tree_version, traversal_order, algorithm_version, sequence, labels, steps, total_steps, steps_truncated, structure_restored, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tree.id,
        tree.version,
        result.order,
        ALGORITHM_VERSION,
        JSON.stringify(result.sequence),
        JSON.stringify(result.labels),
        JSON.stringify(result.steps),
        result.totalSteps,
        result.stepsTruncated ? 1 : 0,
        result.structureRestored ? 1 : 0,
        createdAt,
      );
    return this.getRun(Number(result2.lastInsertRowid))!;
  }

  getRun(id: number): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRun(row) : null;
  }

  listRuns(treeId?: number): RunRecord[] {
    const rows = (
      treeId === undefined
        ? this.db.prepare('SELECT * FROM runs ORDER BY id').all()
        : this.db.prepare('SELECT * FROM runs WHERE tree_id = ? ORDER BY id').all(treeId)
    ) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRun(r));
  }

  private rowToTree(row: Record<string, unknown>): TreeRecord {
    return {
      id: row.id as number,
      name: row.name as string,
      version: row.version as number,
      hash: row.hash as string,
      payload: JSON.parse(row.payload as string) as TreeInput,
      createdAt: row.created_at as string,
    };
  }

  private rowToRun(row: Record<string, unknown>): RunRecord {
    return {
      id: row.id as number,
      treeId: row.tree_id as number,
      treeVersion: row.tree_version as number,
      order: row.traversal_order as TraversalOrder,
      algorithmVersion: row.algorithm_version as string,
      sequence: JSON.parse(row.sequence as string) as number[],
      labels: JSON.parse(row.labels as string) as string[],
      steps: JSON.parse(row.steps as string) as unknown[],
      totalSteps: row.total_steps as number,
      stepsTruncated: (row.steps_truncated as number) === 1,
      structureRestored: (row.structure_restored as number) === 1,
      createdAt: row.created_at as string,
    };
  }
}
