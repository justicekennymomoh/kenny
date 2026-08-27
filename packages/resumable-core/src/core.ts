import { MemoryJournal } from "./journal";
import type {
  ExecutionContext,
  Journal,
  JournalEvent,
  RecoveryPlan,
  Scoreboard,
  StepDef,
  StepSnapshot,
} from "./types";

const needsInverse = (semantics: StepDef["semantics"]) =>
  semantics === "REVERSIBLE" || semantics === "COMPENSATABLE";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}

function keyOf(
  workflowId: string,
  stepId: string,
  args: unknown,
  executionGeneration: number,
): string {
  const stableArgs = stableStringify(args ?? null);
  if (executionGeneration === 0) {
    return `${workflowId}:${stepId}:${stableArgs}`;
  }
  return `${workflowId}:${stepId}:generation:${executionGeneration}:${stableArgs}`;
}

function makeId(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}_${id}`;
}

export class UnknownStepError extends Error {
  constructor(stepId: string) {
    super(`Unknown step: ${stepId}`);
    this.name = "UnknownStepError";
  }
}

export class ApprovalRequiredError extends Error {
  constructor(public readonly stepId: string) {
    super(`${stepId} requires explicit human approval before execution`);
    this.name = "ApprovalRequiredError";
  }
}

export class PrerequisiteError extends Error {
  constructor(public readonly stepId: string) {
    super(`${stepId} is blocked because prior workflow steps are incomplete`);
    this.name = "PrerequisiteError";
  }
}

export class Resumable {
  private listeners = new Set<() => void>();

  constructor(
    private readonly workflowId: string,
    private readonly steps: StepDef[],
    private readonly journal: Journal = new MemoryJournal(),
  ) {
    const ids = new Set<string>();
    for (const step of steps) {
      if (ids.has(step.id)) throw new Error(`Duplicate step id: ${step.id}`);
      ids.add(step.id);
      if (needsInverse(step.semantics) && !step.inverse) {
        throw new Error(`${step.id} is ${step.semantics} but has no inverse()`);
      }
      if (!needsInverse(step.semantics) && step.inverse) {
        throw new Error(`${step.id} is ${step.semantics} and must not declare inverse()`);
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private async append(event: Parameters<Journal["append"]>[0]) {
    const result = await this.journal.append(event);
    this.notify();
    return result;
  }

  private def(stepId: string): StepDef {
    const step = this.steps.find((candidate) => candidate.id === stepId);
    if (!step) throw new UnknownStepError(stepId);
    return step;
  }

  private index(stepId: string): number {
    const index = this.steps.findIndex((step) => step.id === stepId);
    if (index < 0) throw new UnknownStepError(stepId);
    return index;
  }

  private async events(): Promise<JournalEvent[]> {
    return this.journal.list(this.workflowId);
  }

  private async executionGeneration(stepId: string): Promise<number> {
    return (await this.events()).filter(
      (event) => event.stepId === stepId && event.type === "RECOVERY_SUCCEEDED",
    ).length;
  }

  private async activeSuccessByKey(idempotencyKey: string): Promise<JournalEvent | undefined> {
    const relevant = (await this.events()).filter(
      (event) => event.idempotencyKey === idempotencyKey,
    );
    let active: JournalEvent | undefined;
    for (const event of relevant) {
      if (event.type === "STEP_SUCCEEDED") active = event;
      if (event.type === "RECOVERY_SUCCEEDED") active = undefined;
    }
    return active;
  }

  async snapshot(): Promise<StepSnapshot[]> {
    return Promise.all(this.steps.map((step) => this.stepSnapshot(step.id)));
  }

  async stepSnapshot(stepId: string): Promise<StepSnapshot> {
    const def = this.def(stepId);
    const events = (await this.events()).filter((event) => event.stepId === stepId);
    const attempts = events.filter((event) => event.type === "STEP_STARTED").length;
    const hadFailure = events.some((event) => event.type === "STEP_FAILED");

    let status: StepSnapshot["status"] = "not_started";
    let result: unknown;
    let error: string | undefined;
    let lastSeq: number | undefined;

    for (const event of events) {
      switch (event.type) {
        case "STEP_STARTED":
          status = "running";
          error = undefined;
          break;
        case "STEP_SUCCEEDED":
          status = "done";
          result = event.result;
          error = undefined;
          break;
        case "STEP_FAILED":
          status = "failed";
          error = event.error;
          break;
        case "STEP_GATED":
          status = "gated";
          error = event.error;
          break;
        case "RECOVERY_SUCCEEDED":
          status = "undone";
          break;
        default:
          break;
      }
      lastSeq = event.seq;
    }

    return {
      id: def.id,
      title: def.title,
      semantics: def.semantics,
      status,
      result,
      error,
      attempts,
      hadFailure,
      lastSeq,
    };
  }

  private async priorStepsComplete(stepId: string): Promise<boolean> {
    const prior = this.steps.slice(0, this.index(stepId));
    for (const step of prior) {
      if ((await this.stepSnapshot(step.id)).status !== "done") return false;
    }
    return true;
  }

  private async approvalAllows(stepId: string, approvalId?: string): Promise<boolean> {
    if (!approvalId) return false;
    const approvals = (await this.events()).filter(
      (event) => event.type === "APPROVAL_GRANTED" && event.data?.approvalId === approvalId,
    );
    return approvals.some((event) => {
      const ids = event.data?.stepIds;
      return Array.isArray(ids) && ids.includes(stepId);
    });
  }

  async grantApproval(stepIds: string[], reason: string, proposalId?: string) {
    for (const stepId of stepIds) this.def(stepId);
    const approvalId = makeId("approval");
    await this.append({
      workflowId: this.workflowId,
      type: "APPROVAL_GRANTED",
      data: { approvalId, stepIds, reason, proposalId },
    });
    return approvalId;
  }

  async runStep(stepId: string, args: unknown, options?: { approvalId?: string }) {
    const def = this.def(stepId);
    const executionGeneration = await this.executionGeneration(stepId);
    const idempotencyKey = keyOf(
      this.workflowId,
      stepId,
      args,
      executionGeneration,
    );
    const priorSuccess = await this.activeSuccessByKey(idempotencyKey);

    if (priorSuccess) {
      await this.append({
        workflowId: this.workflowId,
        type: "DUPLICATE_PREVENTED",
        stepId,
        idempotencyKey,
        executionGeneration,
        args,
        data: { originalSeq: priorSuccess.seq },
      });
      return priorSuccess.result;
    }

    if (!(await this.priorStepsComplete(stepId))) {
      await this.append({
        workflowId: this.workflowId,
        type: "STEP_GATED",
        stepId,
        idempotencyKey,
        executionGeneration,
        args,
        error: "PREREQUISITE_INCOMPLETE",
      });
      throw new PrerequisiteError(stepId);
    }

    if (
      def.semantics === "IRREVERSIBLE" &&
      !(await this.approvalAllows(stepId, options?.approvalId))
    ) {
      await this.append({
        workflowId: this.workflowId,
        type: "STEP_GATED",
        stepId,
        idempotencyKey,
        executionGeneration,
        args,
        error: "HUMAN_APPROVAL_REQUIRED",
      });
      throw new ApprovalRequiredError(stepId);
    }

    const attemptId = makeId("attempt");
    const context: ExecutionContext = {
      workflowId: this.workflowId,
      stepId,
      attemptId,
      idempotencyKey,
      executionGeneration,
    };

    await this.append({
      workflowId: this.workflowId,
      type: "STEP_STARTED",
      stepId,
      attemptId,
      idempotencyKey,
      executionGeneration,
      args,
    });

    try {
      const result = await def.run(args, context);
      await this.append({
        workflowId: this.workflowId,
        type: "STEP_SUCCEEDED",
        stepId,
        attemptId,
        idempotencyKey,
        executionGeneration,
        args,
        result,
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.append({
        workflowId: this.workflowId,
        type: "STEP_FAILED",
        stepId,
        attemptId,
        idempotencyKey,
        executionGeneration,
        args,
        error: message,
      });
      throw error;
    }
  }

  async run(inputs: Record<string, unknown>, options?: { approvalId?: string }) {
    for (const step of this.steps) {
      await this.runStep(step.id, inputs[step.id], options);
    }
  }

  async resumeFrom(
    stepId: string,
    inputs: Record<string, unknown>,
    options?: { approvalId?: string },
  ) {
    const start = this.index(stepId);
    for (const step of this.steps.slice(start)) {
      await this.runStep(step.id, inputs[step.id], options);
    }
  }

  async undoStep(stepId: string) {
    const def = this.def(stepId);
    const snapshot = await this.stepSnapshot(stepId);
    if (snapshot.status !== "done") {
      return { undone: false, reason: "not completed" } as const;
    }
    if (def.semantics === "IRREVERSIBLE") {
      return { undone: false, reason: "irreversible: cannot be undone" } as const;
    }
    if (def.semantics === "READ_ONLY") {
      return { undone: true, reason: "read-only: no side effect to undo" } as const;
    }

    const events = (await this.events()).filter(
      (event) => event.stepId === stepId && event.type === "STEP_SUCCEEDED",
    );
    const success = events[events.length - 1];
    if (!success) return { undone: false, reason: "no successful attempt found" } as const;

    const recoveryAttemptId = makeId("recovery");
    const executionGeneration =
      success.executionGeneration ?? (await this.executionGeneration(stepId));
    const context: ExecutionContext = {
      workflowId: this.workflowId,
      stepId,
      attemptId: recoveryAttemptId,
      idempotencyKey: `recovery:${success.idempotencyKey ?? stepId}`,
      executionGeneration,
    };

    await this.append({
      workflowId: this.workflowId,
      type: "RECOVERY_STARTED",
      stepId,
      attemptId: recoveryAttemptId,
      idempotencyKey: success.idempotencyKey,
      executionGeneration,
      args: success.args,
      data: { semantics: def.semantics },
    });

    try {
      await def.inverse!(success.args, success.result, context);
      await this.append({
        workflowId: this.workflowId,
        type: "RECOVERY_SUCCEEDED",
        stepId,
        attemptId: recoveryAttemptId,
        idempotencyKey: success.idempotencyKey,
        executionGeneration,
        args: success.args,
        result: success.result,
        data: { semantics: def.semantics },
      });
      return { undone: true, reason: `${def.semantics.toLowerCase()} recovery applied` } as const;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.append({
        workflowId: this.workflowId,
        type: "RECOVERY_FAILED",
        stepId,
        attemptId: recoveryAttemptId,
        idempotencyKey: success.idempotencyKey,
        executionGeneration,
        args: success.args,
        error: message,
      });
      throw error;
    }
  }

  async getRecoveryPlan(): Promise<RecoveryPlan | null> {
    const snapshots = await this.snapshot();
    const failedIndex = snapshots.findIndex((step) => step.status === "failed");
    if (failedIndex < 0) return null;

    const failed = snapshots[failedIndex];
    const preserve = snapshots
      .slice(0, failedIndex)
      .filter((step) => step.status === "done");
    const blocked = snapshots
      .slice(failedIndex + 1)
      .filter((step) => step.status === "gated" || step.semantics === "IRREVERSIBLE")
      .map((step) => ({
        step: step.id,
        title: step.title,
        reason:
          step.semantics === "IRREVERSIBLE"
            ? "IRREVERSIBLE_REQUIRES_HUMAN_APPROVAL"
            : "PREREQUISITE_INCOMPLETE",
      }));

    return {
      failedStep: failed.id,
      failedStepTitle: failed.title,
      preserve: preserve.map((step) => step.id),
      preserveTitles: preserve.map((step) => step.title),
      recover: { step: failed.id, options: ["RETRY", "REPLACE_INPUT"] },
      blocked,
      resumePoint: failed.id,
    };
  }

  async timeline() {
    return this.events();
  }

  async scoreboard(): Promise<Scoreboard> {
    const events = await this.events();
    const snapshots = await this.snapshot();
    const firstFailure = events.find((event) => event.type === "STEP_FAILED");

    const completed = snapshots.filter((step) => step.status === "done").length;
    const failuresRecovered = snapshots.filter(
      (step) => step.status === "done" && step.hadFailure,
    ).length;
    const actionsPreserved = firstFailure
      ? snapshots.filter((step) => {
          if (step.status !== "done" || step.hadFailure) return false;
          return events.some(
            (event) =>
              event.stepId === step.id &&
              event.type === "STEP_SUCCEEDED" &&
              event.seq < firstFailure.seq,
          );
        }).length
      : 0;

    return {
      completed,
      failuresRecovered,
      actionsPreserved,
      duplicatesPrevented: events.filter((event) => event.type === "DUPLICATE_PREVENTED").length,
      recoveryActionsRun: events.filter((event) => event.type === "RECOVERY_SUCCEEDED").length,
      irreversibleActionsGated: events.filter(
        (event) => event.type === "STEP_GATED" && event.error === "HUMAN_APPROVAL_REQUIRED",
      ).length,
    };
  }

  async reset() {
    await this.journal.clear(this.workflowId);
    this.notify();
  }
}
