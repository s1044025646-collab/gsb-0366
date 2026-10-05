export const ALGORITHM_VERSION = "morris-1.0.0";

export interface InputNode {
  id: string;
  label: string;
  left?: string | null;
  right?: string | null;
}

export interface TreeInput {
  rootId: string | null;
  nodes: InputNode[];
}

export interface StructuralEdge {
  from: string;
  side: "left" | "right";
  to: string;
  temporary: boolean;
}

export type TraversalMode = "inorder" | "preorder";

export type StepKind =
  | "visit"
  | "find-predecessor-start"
  | "find-predecessor-move"
  | "thread-create"
  | "thread-remove"
  | "move-left"
  | "move-right"
  | "finish";

export interface PointerSnapshot {
  side: "left" | "right";
  oldValue: string | null;
  newValue: string | null;
}

export interface MorrisStep {
  index: number;
  kind: StepKind;
  current: string | null;
  predecessor: string | null;
  pointer?: PointerSnapshot;
  traversedEdge?: StructuralEdge | null;
  activeThreads: StructuralEdge[];
  note: string;
}

export interface MorrisResult {
  mode: TraversalMode;
  order: string[];
  steps: MorrisStep[];
  temporaryThreadsCreated: number;
  temporaryThreadsRemoved: number;
  structureRestored: boolean;
  beforeEdges: StructuralEdge[];
  afterEdges: StructuralEdge[];
  algorithmVersion: string;
}

export interface ServiceError {
  code:
    | "EMPTY_INPUT"
    | "MAX_NODES_EXCEEDED"
    | "LABEL_TOO_LONG"
    | "DUPLICATE_NODE_ID"
    | "INVALID_NODE_ID"
    | "UNKNOWN_REFERENCE"
    | "SELF_REFERENCE"
    | "DUPLICATE_PARENT"
    | "ROOT_NOT_FOUND"
    | "MULTIPLE_ROOTS"
    | "UNREACHABLE_NODE"
    | "CYCLE_DETECTED"
    | "NOT_FOUND"
    | "INVALID_ARGUMENT"
    | "INTERNAL_INVARIANT_FAILED";
  message: string;
  details?: unknown;
}

export class MorrisServiceError extends Error {
  code: ServiceError["code"];
  details?: unknown;

  constructor(code: ServiceError["code"], message: string, details?: unknown) {
    super(message);
    this.name = "MorrisServiceError";
    this.code = code;
    this.details = details;
  }
}

export interface Limits {
  maxNodes: number;
  maxLabelLength: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxNodes: 5000,
  maxLabelLength: 500
};

export interface TruncationOptions {
  maxSteps?: number;
}

export interface StoredTree {
  id: number;
  version: number;
  root_id: string | null;
  payload: string;
  created_at: string;
}

export interface StoredRun {
  id: number;
  tree_id: number;
  tree_version: number;
  mode: TraversalMode;
  algorithm_version: string;
  order_json: string;
  steps_json: string;
  before_edges_json: string;
  after_edges_json: string;
  threads_created: number;
  threads_removed: number;
  structure_restored: number;
  truncated: number;
  created_at: string;
}
