export type RecoverySemantics =
  | "READ_ONLY"
  | "REVERSIBLE"
  | "COMPENSATABLE"
  | "IRREVERSIBLE";

export type StepStatus =
  | "not_started"
  | "running"
  | "done"
  | "failed"
  | "undone"
  | "gated";

export type JournalEventType =
  | "STEP_STARTED"
  | "STEP_SUCCEEDED"
  | "STEP_FAILED"
  | "STEP_GATED"
  | "DUPLICATE_PREVENTED"
  | "RECOVERY_STARTED"
  | "RECOVERY_SUCCEEDED"
  | "RECOVERY_FAILED"
  | "APPROVAL_GRANTED";

export interface ExecutionContext {
  workflowId: string;
  stepId: string;
  attemptId: string;
  idempotencyKey: string;
  executionGeneration: number;
}

export interface StepDef<A = unknown, R = unknown> {
  id: string;
  title: string;
  semantics: RecoverySemantics;
  run: (args: A, context: ExecutionContext) => Promise<R>;
  inverse?: (args: A, result: R, context: ExecutionContext) => Promise<void>;
}

export interface JournalEvent {
  seq: number;
  at: number;
  workflowId: string;
  type: JournalEventType;
  stepId?: string;
  attemptId?: string;
  idempotencyKey?: string;
  executionGeneration?: number;
  args?: unknown;
  result?: unknown;
  error?: string;
  data?: Record<string, unknown>;
}

export type NewJournalEvent = Omit<JournalEvent, "seq" | "at"> & {
  at?: number;
};

export interface Journal {
  append(event: NewJournalEvent): Promise<JournalEvent>;
  list(workflowId?: string): Promise<JournalEvent[]>;
  clear(workflowId?: string): Promise<void>;
}

export interface StepSnapshot {
  id: string;
  title: string;
  semantics: RecoverySemantics;
  status: StepStatus;
  result?: unknown;
  error?: string;
  attempts: number;
  hadFailure: boolean;
  lastSeq?: number;
}

export interface RecoveryPlan {
  failedStep: string;
  failedStepTitle: string;
  preserve: string[];
  preserveTitles: string[];
  recover: {
    step: string;
    options: Array<"RETRY" | "REPLACE_INPUT">;
  };
  blocked: Array<{ step: string; title: string; reason: string }>;
  resumePoint: string;
}

export interface Scoreboard {
  completed: number;
  failuresRecovered: number;
  actionsPreserved: number;
  duplicatesPrevented: number;
  recoveryActionsRun: number;
  irreversibleActionsGated: number;
}
