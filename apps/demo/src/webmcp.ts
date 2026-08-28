import {
  registerWebMcpTools,
  type RegisterToolsResult,
  type WebMcpTool,
} from "@recovery/webmcp";
import { demoBackend } from "./demoBackend";
import {
  getProposal,
  isOrientationSlot,
  setProposal,
} from "./proposals";
import {
  approvalMatchesCurrentProposal,
  buildRecoveryContract,
} from "./recoveryContract";
import { serializeOnboardingMutation } from "./mutationLock";
import { baseInputs, resumable, WORKFLOW_ID } from "./workflow";

const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

export const serializeDemoMutation = serializeOnboardingMutation;

function workflowStatus(steps: Awaited<ReturnType<typeof resumable.snapshot>>) {
  if (steps.every((step) => step.status === "not_started")) return "not_started";
  if (steps.every((step) => step.status === "done")) return "complete";
  if (steps.some((step) => step.status === "failed")) return "paused_on_failure";
  if (steps.some((step) => step.status === "running")) return "running";
  return "paused";
}

async function currentState() {
  const [steps, plan, backend, proposal] = await Promise.all([
    resumable.snapshot(),
    resumable.getRecoveryPlan(),
    demoBackend.state(),
    getProposal(),
  ]);
  const approvalValid = await approvalMatchesCurrentProposal(proposal);
  const pendingFailure = steps.find((step) => step.status === "failed");

  return {
    workflowId: WORKFLOW_ID,
    workflowStatus: workflowStatus(steps),
    steps: steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      recoverySemantics: step.semantics,
      attempts: step.attempts,
      ...(step.error ? { error: step.error } : {}),
    })),
    sideEffects: {
      employees: backend.employees.length,
      workspaces: backend.workspaces.length,
      figmaLicences: backend.figma.length,
      laptops: Object.values(backend.orders).filter((status) => status === "placed").length,
      orientation: Object.values(backend.bookings)[0] ?? null,
      welcomeEmails: backend.emails.length,
    },
    pendingFailure: pendingFailure
      ? { step: pendingFailure.id, error: pendingFailure.error ?? "UNKNOWN_FAILURE" }
      : null,
    humanApproval: {
      pending: proposal?.status === "pending",
      approved: proposal?.status === "approved",
      validForCurrentState: approvalValid,
      proposal: proposal
        ? { id: proposal.id, slot: proposal.slot, status: proposal.status }
        : null,
    },
    recoveryPlanAvailable: plan !== null,
    canResume: approvalValid,
  };
}

function checkCancellation(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

export function createDemoTools(): WebMcpTool[] {
  return [
    {
      name: "get_onboarding_state",
      title: "Get onboarding state",
      description:
        "Use to inspect Maya's persisted onboarding before deciding what to do next. Returns workflow steps, recovery semantics, side-effect counts, failure, approval state, and whether resume is allowed. Read-only.",
      inputSchema: emptyInputSchema,
      annotations: { readOnlyHint: true },
      execute: async (_input, context) => {
        const signal = context?.signal;
        checkCancellation(signal);
        const state = await currentState();
        checkCancellation(signal);
        return state;
      },
    },
    {
      name: "start_onboarding",
      title: "Start Maya onboarding",
      description:
        "Use only to start Maya's fixed Monday onboarding from a clean state. It runs until Monday orientation fails; it cannot accept hidden workflow inputs. If already started, it returns the persisted state without restarting.",
      inputSchema: emptyInputSchema,
      execute: (_input, context) => serializeDemoMutation(async () => {
        const signal = context?.signal;
        checkCancellation(signal);
        const before = await resumable.snapshot();
        checkCancellation(signal);
        if (before.some((step) => step.status !== "not_started")) {
          return {
            started: false,
            reason: "WORKFLOW_ALREADY_STARTED",
            state: await currentState(),
          };
        }

        try {
          await resumable.run(baseInputs);
        } catch (error) {
          checkCancellation(signal);
          return {
            started: true,
            outcome: "paused_on_failure",
            failure: error instanceof Error ? error.message : String(error),
            state: await currentState(),
          };
        }

        checkCancellation(signal);
        return { started: true, outcome: "complete", state: await currentState() };
      }, context?.signal),
    },
    {
      name: "get_recovery_plan",
      title: "Get recovery plan",
      description:
        "Use after onboarding pauses to read the recovery plan generated from persisted Resumable state. Reports work to preserve, recovery options, blocked irreversible actions, and the safe resume point. Read-only.",
      inputSchema: emptyInputSchema,
      annotations: { readOnlyHint: true },
      execute: async (_input, context) => {
        const signal = context?.signal;
        checkCancellation(signal);
        const [plan, steps, proposal] = await Promise.all([
          resumable.getRecoveryPlan(),
          resumable.snapshot(),
          getProposal(),
        ]);
        const validApprovalExists = await approvalMatchesCurrentProposal(proposal);
        const contract = buildRecoveryContract(steps, plan, validApprovalExists);
        checkCancellation(signal);
        return { available: plan !== null, plan, ...contract };
      },
    },
    {
      name: "search_orientation_slots",
      title: "Search orientation slots",
      description:
        "Use after Monday orientation fails to read the deterministic alternative slots available for recovery. Returns Tuesday and Wednesday and does not change workflow state. Read-only.",
      inputSchema: emptyInputSchema,
      annotations: { readOnlyHint: true },
      execute: async (_input, context) => {
        const signal = context?.signal;
        checkCancellation(signal);
        const slots = await demoBackend.searchOrientationSlots();
        checkCancellation(signal);
        return slots;
      },
    },
    {
      name: "propose_recovery",
      title: "Propose recovery",
      description:
        "Use after reading the recovery plan to propose Tuesday or Wednesday. This only creates the visible proposal; it never approves or executes recovery. Stop and wait for the human to approve in the webpage.",
      inputSchema: {
        type: "object",
        properties: {
          slot: {
            type: "string",
            enum: ["Tuesday", "Wednesday"],
            description: "The replacement orientation slot to show the human.",
          },
        },
        required: ["slot"],
        additionalProperties: false,
      },
      execute: (input, context) => serializeDemoMutation(async () => {
        const signal = context?.signal;
        checkCancellation(signal);
        const keys = Object.keys(input);
        if (keys.length !== 1 || keys[0] !== "slot" || !isOrientationSlot(input.slot)) {
          throw new TypeError("slot must be exactly Tuesday or Wednesday");
        }

        const plan = await resumable.getRecoveryPlan();
        checkCancellation(signal);
        if (
          !plan ||
          plan.failedStep !== "book_orientation" ||
          plan.resumePoint !== "book_orientation"
        ) {
          return { proposed: false, reason: "NO_RECOVERABLE_ORIENTATION_FAILURE" };
        }

        const proposal = {
          id: `proposal_${globalThis.crypto.randomUUID()}`,
          slot: input.slot,
          status: "pending" as const,
        };
        await setProposal(proposal);
        checkCancellation(signal);
        return {
          proposed: true,
          waitingForHuman: true,
          proposal: { id: proposal.id, slot: proposal.slot, status: proposal.status },
          preserves: plan.preserve,
          resumePointAfterApproval: plan.resumePoint,
        };
      }, context?.signal),
    },
    {
      name: "resume_onboarding",
      title: "Resume onboarding",
      description:
        "Use only after the human approves the current visible recovery proposal. Fails closed for missing, pending, stale, or mismatched approval. On success it preserves completed work, books the approved slot, and sends one welcome email.",
      inputSchema: emptyInputSchema,
      execute: (_input, context) => serializeDemoMutation(async () => {
        const signal = context?.signal;
        checkCancellation(signal);
        const proposal = await getProposal();
        const approvalValid = await approvalMatchesCurrentProposal(proposal);
        checkCancellation(signal);
        if (!proposal || !approvalValid || !proposal.approvalId) {
          return {
            resumed: false,
            reason: "HUMAN_APPROVAL_REQUIRED_OR_STALE",
            humanAction: "Approve the current recovery proposal in the webpage.",
          };
        }

        await resumable.resumeFrom(
          "book_orientation",
          {
            ...baseInputs,
            book_orientation: { name: "Maya", slot: proposal.slot },
          },
          { approvalId: proposal.approvalId },
        );
        checkCancellation(signal);
        return { resumed: true, state: await currentState() };
      }, context?.signal),
    },
  ];
}

export async function registerDemoTools(
  signal?: AbortSignal,
): Promise<RegisterToolsResult> {
  return registerWebMcpTools(document.modelContext, createDemoTools(), { signal });
}
