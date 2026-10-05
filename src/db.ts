import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ALGORITHM_VERSION,
  MorrisResult,
  MorrisServiceError,
  StoredRun,
  StoredTree,
  TraversalMode,
  TreeInput
} from "./types.js";
import { runMorris } from "./morris.js";
import { validateTree } from "./validation.js";

export interface TreeVersionSummary {
  tree_id: number;
  version: number;
  root_id: string | null;
  payload: string;
  content_hash: string;
  created_at: string;
}

export interface RunComparison {
  firstRunId: number;
  secondRunId: number;
  sameOrder: boolean;
  firstOrder: string[];
  secondOrder: string[];
  positions: Array<{
    nodeId: string;
    firstPosition: number;
    secondPosition: number;
  }>;
}

export class MorrisStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tree_versions (
        tree_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        root_id TEXT,
        payload TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (tree_id, version),
        UNIQUE (content_hash)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tree_id INTEGER NOT NULL,
        tree_version INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('inorder', 'preorder')),
        algorithm_version TEXT NOT NULL,
        order_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        before_edges_json TEXT NOT NULL,
        after_edges_json TEXT NOT NULL,
        threads_created INTEGER NOT NULL,
        threads_removed INTEGER NOT NULL,
        structure_restored INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (tree_id, tree_version) REFERENCES tree_versions(tree_id, version)
      );
    `);
  }

  importTree(input: unknown, parentTreeId?: number): TreeVersionSummary {
    const validated = validateTree(input);
    const canonical = toCanonicalInput(validated);
    const payload = JSON.stringify(canonical);
    const contentHash = createHash("sha256").update(payload).digest("hex");

    const existing = this.db
      .prepare("SELECT * FROM tree_versions WHERE content_hash = ?")
      .get(contentHash) as TreeVersionSummary | undefined;
    if (existing) return existing;

    let treeId: number;
    let version: number;

    if (parentTreeId !== undefined) {
      const row = this.db
        .prepare(
          "SELECT MAX(version) AS version FROM tree_versions WHERE tree_id = ?"
        )
        .get(parentTreeId) as { version: number | null } | undefined;
      if (!row || row.version === null) {
        throw new MorrisServiceError(
          "NOT_FOUND",
          `父树不存在：${parentTreeId}`,
          { parentTreeId }
        );
      }
      treeId = parentTreeId;
      version = row.version + 1;
    } else {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(tree_id), 0) + 1 AS next_id FROM tree_versions"
        )
        .get() as { next_id: number };
      treeId = row.next_id;
      version = 1;
    }

    this.db
      .prepare(
        `INSERT INTO tree_versions
          (tree_id, version, root_id, payload, content_hash)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        treeId,
        version,
        validated.rootId,
        payload,
        contentHash
      );

    return this.getTreeVersion(treeId, version) as TreeVersionSummary;
  }

  listTrees(): TreeVersionSummary[] {
    return this.db
      .prepare("SELECT * FROM tree_versions ORDER BY tree_id, version")
      .all() as unknown as TreeVersionSummary[];
  }

  getTreeVersion(treeId: number, version?: number): TreeVersionSummary | undefined {
    if (version === undefined) {
      return this.db
        .prepare(
          `SELECT * FROM tree_versions
           WHERE tree_id = ?
           ORDER BY version DESC LIMIT 1`
        )
        .get(treeId) as TreeVersionSummary | undefined;
    }
    return this.db
      .prepare("SELECT * FROM tree_versions WHERE tree_id = ? AND version = ?")
      .get(treeId, version) as TreeVersionSummary | undefined;
  }

  validateTree(treeId: number, version?: number) {
    const tree = this.requireTree(treeId, version);
    validateTree(JSON.parse(tree.payload));
    return {
      treeId: tree.tree_id,
      version: tree.version,
      rootId: tree.root_id,
      valid: true as const,
      nodeCount: (JSON.parse(tree.payload) as TreeInput).nodes.length
    };
  }

  runAndSave(
    treeId: number,
    mode: TraversalMode,
    version?: number
  ): { run: StoredRun; result: MorrisResult } {
    const tree = this.requireTree(treeId, version);
    const result = runMorris(validateTree(JSON.parse(tree.payload)), mode);

    const insert = this.db.prepare(
      `INSERT INTO runs (
         tree_id, tree_version, mode, algorithm_version,
         order_json, steps_json, before_edges_json, after_edges_json,
         threads_created, threads_removed, structure_restored, truncated
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );

    let runId = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const info = insert.run(
        tree.tree_id,
        tree.version,
        mode,
        ALGORITHM_VERSION,
        JSON.stringify(result.order),
        JSON.stringify(result.steps),
        JSON.stringify(result.beforeEdges),
        JSON.stringify(result.afterEdges),
        result.temporaryThreadsCreated,
        result.temporaryThreadsRemoved,
        result.structureRestored ? 1 : 0
      );
      runId = Number(info.lastInsertRowid);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const run = this.getRun(runId);
    return { run, result };
  }

  getRun(runId: number): StoredRun {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId) as StoredRun | undefined;
    if (!row) {
      throw new MorrisServiceError("NOT_FOUND", `运行不存在：${runId}`, { runId });
    }
    return row;
  }

  private findRun(runId: number): StoredRun | undefined {
    return this.db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId) as StoredRun | undefined;
  }

  listRuns(treeId?: number): StoredRun[] {
    if (treeId === undefined) {
      return this.db
        .prepare("SELECT * FROM runs ORDER BY id")
        .all() as unknown as StoredRun[];
    }
    return this.db
      .prepare("SELECT * FROM runs WHERE tree_id = ? ORDER BY id")
      .all(treeId) as unknown as StoredRun[];
  }

  getStep(runId: number, stepIndex: number) {
    const run = this.requireRun(runId);
    const steps = JSON.parse(run.steps_json) as MorrisResult["steps"];
    if (!Number.isInteger(stepIndex) || stepIndex < 1 || stepIndex > steps.length) {
      throw new MorrisServiceError(
        "INVALID_ARGUMENT",
        `步骤编号必须在 1..${steps.length} 之间`,
        { stepIndex, totalSteps: steps.length }
      );
    }
    return { runId, step: steps[stepIndex - 1] };
  }

  verifyRestoration(runId: number) {
    const run = this.requireRun(runId);
    const before = JSON.parse(run.before_edges_json) as MorrisResult["beforeEdges"];
    const after = JSON.parse(run.after_edges_json) as MorrisResult["afterEdges"];
    const edgeEqual =
      JSON.stringify([...before].sort(compareEdge)) ===
      JSON.stringify([...after].sort(compareEdge));
    return {
      runId,
      structureRestored:
        run.structure_restored === 1 &&
        edgeEqual &&
        run.threads_created === run.threads_removed,
      threadsCreated: run.threads_created,
      threadsRemoved: run.threads_removed,
      beforeEdges: before,
      afterEdges: after
    };
  }

  compareRuns(firstRunId: number, secondRunId: number): RunComparison {
    const first = this.requireRun(firstRunId);
    const second = this.requireRun(secondRunId);
    const firstOrder = JSON.parse(first.order_json) as string[];
    const secondOrder = JSON.parse(second.order_json) as string[];
    const all = new Set([...firstOrder, ...secondOrder]);
    return {
      firstRunId,
      secondRunId,
      sameOrder: JSON.stringify(firstOrder) === JSON.stringify(secondOrder),
      firstOrder,
      secondOrder,
      positions: [...all].map((nodeId) => ({
        nodeId,
        firstPosition: firstOrder.indexOf(nodeId) + 1,
        secondPosition: secondOrder.indexOf(nodeId) + 1
      }))
    };
  }

  exportReport(runId: number, maxSteps?: number) {
    const run = this.requireRun(runId);
    const tree = this.requireTree(run.tree_id, run.tree_version);
    const result = this.resultFromRun(run);
    const steps =
      maxSteps === undefined
        ? result.steps
        : result.steps.slice(0, clampMaxSteps(maxSteps, result.steps.length));
    return {
      run: {
        id: run.id,
        treeId: run.tree_id,
        treeVersion: run.tree_version,
        mode: run.mode,
        algorithmVersion: run.algorithm_version,
        createdAt: run.created_at
      },
      tree: JSON.parse(tree.payload) as TreeInput,
      order: result.order,
      steps,
      stepTruncated: steps.length < result.steps.length,
      totalSteps: result.steps.length,
      threadsCreated: result.temporaryThreadsCreated,
      threadsRemoved: result.temporaryThreadsRemoved,
      structureRestored: result.structureRestored,
      beforeEdges: result.beforeEdges,
      afterEdges: result.afterEdges
    };
  }

  resultFromRun(run: StoredRun): MorrisResult {
    return {
      mode: run.mode,
      order: JSON.parse(run.order_json),
      steps: JSON.parse(run.steps_json),
      temporaryThreadsCreated: run.threads_created,
      temporaryThreadsRemoved: run.threads_removed,
      structureRestored: run.structure_restored === 1,
      beforeEdges: JSON.parse(run.before_edges_json),
      afterEdges: JSON.parse(run.after_edges_json),
      algorithmVersion: run.algorithm_version
    };
  }

  private requireTree(treeId: number, version?: number): TreeVersionSummary {
    const tree = this.getTreeVersion(treeId, version);
    if (!tree) {
      throw new MorrisServiceError(
        "NOT_FOUND",
        version === undefined
          ? `树不存在：${treeId}`
          : `树版本不存在：${treeId} v${version}`,
        { treeId, version }
      );
    }
    return tree;
  }

  private requireRun(runId: number): StoredRun {
    const run = this.findRun(runId);
    if (!run) {
      throw new MorrisServiceError("NOT_FOUND", `运行不存在：${runId}`, { runId });
    }
    return run;
  }
}

function toCanonicalInput(validated: ReturnType<typeof validateTree>): TreeInput {
  return {
    rootId: validated.rootId,
    nodes: [...validated.nodes.values()]
      .map((node) => ({ id: node.id, label: node.label, left: node.left, right: node.right }))
      .sort((a, b) => a.id.localeCompare(b.id))
  };
}

function compareEdge(
  a: { from: string; side: string; to: string },
  b: { from: string; side: string; to: string }
): number {
  return `${a.from}:${a.side}:${a.to}`.localeCompare(`${b.from}:${b.side}:${b.to}`);
}

function clampMaxSteps(value: number, total: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new MorrisServiceError("INVALID_ARGUMENT", "maxSteps 必须是非负整数", {
      value
    });
  }
  return Math.min(value, total);
}
