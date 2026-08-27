import { describe, expect, it } from "vitest";
import {
  ApprovalRequiredError,
  MemoryJournal,
  Resumable,
  UnknownStepError,
  type StepDef,
} from "../src";

function makeWorkflow() {
  const sideEffects = { employees: 0, laptops: 0, emails: 0, bookings: [] as string[] };
  const idem = new Map<string, unknown>();

  const steps: StepDef[] = [
    {
      id: "create_employee",
      title: "Create employee",
      semantics: "REVERSIBLE",
      run: async (_args, ctx) => {
        if (idem.has(ctx.idempotencyKey)) return idem.get(ctx.idempotencyKey);
        sideEffects.employees++;
        const result = { id: "emp_maya" };
        idem.set(ctx.idempotencyKey, result);
        return result;
      },
      inverse: async () => {
        sideEffects.employees--;
      },
    },
    {
      id: "order_laptop",
      title: "Order laptop",
      semantics: "COMPENSATABLE",
      run: async (_args, ctx) => {
        if (idem.has(ctx.idempotencyKey)) return idem.get(ctx.idempotencyKey);
        sideEffects.laptops++;
        const result = { id: "laptop_1" };
        idem.set(ctx.idempotencyKey, result);
        return result;
      },
      inverse: async () => {
        sideEffects.laptops--;
      },
    },
    {
      id: "book_orientation",
      title: "Book orientation",
      semantics: "COMPENSATABLE",
      run: async (args: any) => {
        if (args.slot === "Monday") throw new Error("ORIENTATION_FULL");
        sideEffects.bookings.push(args.slot);
        return { slot: args.slot };
      },
      inverse: async (_args, result: any) => {
        sideEffects.bookings = sideEffects.bookings.filter((slot) => slot !== result.slot);
      },
    },
    {
      id: "send_email",
      title: "Send email",
      semantics: "IRREVERSIBLE",
      run: async () => {
        sideEffects.emails++;
        return { sent: true };
      },
    },
  ];

  return {
    sideEffects,
    R: new Resumable("wf", steps, new MemoryJournal()),
  };
}

describe("Resumable", () => {
  it("preserves completed steps and resumes from failure with new input", async () => {
    const { R, sideEffects } = makeWorkflow();
    const base = {
      create_employee: { name: "Maya" },
      order_laptop: { name: "Maya" },
      book_orientation: { name: "Maya", slot: "Monday" },
      send_email: { name: "Maya" },
    };

    await expect(R.run(base)).rejects.toThrow("ORIENTATION_FULL");
    const plan = await R.getRecoveryPlan();
    expect(plan?.preserve).toEqual(["create_employee", "order_laptop"]);
    expect(plan?.resumePoint).toBe("book_orientation");

    const approvalId = await R.grantApproval(
      ["send_email"],
      "Human approved finishing onboarding and sending email",
    );
    await R.resumeFrom(
      "book_orientation",
      { ...base, book_orientation: { name: "Maya", slot: "Tuesday" } },
      { approvalId },
    );

    expect(sideEffects.employees).toBe(1);
    expect(sideEffects.laptops).toBe(1);
    expect(sideEffects.bookings).toEqual(["Tuesday"]);
    expect(sideEffects.emails).toBe(1);

    const score = await R.scoreboard();
    expect(score.completed).toBe(4);
    expect(score.failuresRecovered).toBe(1);
    expect(score.actionsPreserved).toBe(2);
  });

  it("short-circuits an already successful step", async () => {
    const { R, sideEffects } = makeWorkflow();
    await R.runStep("create_employee", { name: "Maya" });
    await R.runStep("create_employee", { name: "Maya" });
    expect(sideEffects.employees).toBe(1);
    expect((await R.scoreboard()).duplicatesPrevented).toBe(1);
  });

  it("uses a fresh idempotency generation after successful compensation", async () => {
    let sideEffects = 0;
    const idempotency = new Map<string, { execution: number }>();
    const executedKeys: string[] = [];
    const step: StepDef<{ name: string }, { execution: number }> = {
      id: "create_resource",
      title: "Create resource",
      semantics: "REVERSIBLE",
      run: async (_args, context) => {
        executedKeys.push(context.idempotencyKey);
        const previous = idempotency.get(context.idempotencyKey);
        if (previous) return previous;
        sideEffects++;
        const result = { execution: sideEffects };
        idempotency.set(context.idempotencyKey, result);
        return result;
      },
      inverse: async () => {
        sideEffects--;
      },
    };
    const R = new Resumable("generation-workflow", [step], new MemoryJournal());
    const args = { name: "Maya" };

    await R.runStep(step.id, args);
    await R.runStep(step.id, args);
    expect(sideEffects).toBe(1);
    expect(executedKeys).toHaveLength(1);
    expect((await R.scoreboard()).duplicatesPrevented).toBe(1);

    await R.undoStep(step.id);
    expect(sideEffects).toBe(0);

    await R.runStep(step.id, args);
    await R.runStep(step.id, args);
    expect(sideEffects).toBe(1);
    expect(executedKeys).toHaveLength(2);
    expect(executedKeys[1]).not.toBe(executedKeys[0]);
    expect(executedKeys[1]).toContain(":generation:1:");
    expect((await R.scoreboard()).duplicatesPrevented).toBe(2);
  });

  it("does not advance idempotency generation after failed compensation", async () => {
    let runCalls = 0;
    const executedKeys: string[] = [];
    const step: StepDef = {
      id: "create_resource",
      title: "Create resource",
      semantics: "REVERSIBLE",
      run: async (_args, context) => {
        runCalls++;
        executedKeys.push(context.idempotencyKey);
        return { created: true };
      },
      inverse: async () => {
        throw new Error("RECOVERY_FAILED");
      },
    };
    const R = new Resumable("failed-recovery-workflow", [step], new MemoryJournal());

    await R.runStep(step.id, { name: "Maya" });
    await expect(R.undoStep(step.id)).rejects.toThrow("RECOVERY_FAILED");
    await R.runStep(step.id, { name: "Maya" });

    expect(runCalls).toBe(1);
    expect(executedKeys).toHaveLength(1);
    expect((await R.scoreboard()).duplicatesPrevented).toBe(1);
  });

  it("keeps MemoryJournal history isolated from caller mutations", async () => {
    const journal = new MemoryJournal();
    const args = { employee: { name: "Maya" } };
    const result = { account: { id: "emp_maya" } };

    const appended = await journal.append({
      workflowId: "immutable-workflow",
      type: "STEP_SUCCEEDED",
      stepId: "create_employee",
      args,
      result,
    });

    args.employee.name = "Changed original args";
    result.account.id = "changed_original_result";
    (appended.args as typeof args).employee.name = "Changed append response";
    (appended.result as typeof result).account.id = "changed_append_response";

    const firstRead = await journal.list("immutable-workflow");
    expect(firstRead[0].args).toEqual({ employee: { name: "Maya" } });
    expect(firstRead[0].result).toEqual({ account: { id: "emp_maya" } });

    (firstRead[0].args as typeof args).employee.name = "Changed read args";
    (firstRead[0].result as typeof result).account.id = "changed_read_result";

    const secondRead = await journal.list("immutable-workflow");
    expect(secondRead[0].args).toEqual({ employee: { name: "Maya" } });
    expect(secondRead[0].result).toEqual({ account: { id: "emp_maya" } });
    expect(secondRead[0].seq).toBe(1);
  });

  it("gates irreversible actions without explicit approval", async () => {
    const { R } = makeWorkflow();
    await R.runStep("create_employee", { name: "Maya" });
    await R.runStep("order_laptop", { name: "Maya" });
    await R.runStep("book_orientation", { name: "Maya", slot: "Tuesday" });
    await expect(R.runStep("send_email", { name: "Maya" })).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
  });

  it("fails closed for unknown resume points", async () => {
    const { R } = makeWorkflow();
    await expect(R.resumeFrom("typo", {})).rejects.toBeInstanceOf(UnknownStepError);
  });
});
