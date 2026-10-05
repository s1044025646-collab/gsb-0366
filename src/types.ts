export interface NodeInput {
  id: number;
  label: string;
  left: number | null;
  right: number | null;
}

export interface TreeInput {
  rootId: number | null;
  nodes: NodeInput[];
}

export type StepType = 'visit' | 'find-predecessor' | 'link' | 'unlink' | 'move';

export interface EdgeChange {
  node: number;
  field: 'right';
  oldValue: number | null;
  newValue: number | null;
  /** true 表示该指针当前是原树边（未修改） */
  isOriginalEdge: boolean;
}

export interface Step {
  seq: number;
  type: StepType;
  current: number | null;
  predecessor?: number;
  visited?: number;
  edge?: EdgeChange;
  move?: { from: number; to: number | null; via: 'left' | 'right' | 'thread' };
  note?: string;
}

export type TraversalOrder = 'inorder' | 'preorder';

export interface TraversalResult {
  order: TraversalOrder;
  sequence: number[];
  labels: string[];
  steps: Step[];
  totalSteps: number;
  stepsTruncated: boolean;
  structureRestored: boolean;
}

export interface ValidationError {
  code: string;
  message: string;
  nodeId?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}
